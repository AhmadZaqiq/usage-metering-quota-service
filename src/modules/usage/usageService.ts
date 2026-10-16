import { withTransaction, type Transaction } from "../../db/client.js";
import { users, plans, planAssignments, apiKeys } from "../../db/schema/index.js";
import { eq, and, isNull, sql } from "drizzle-orm";
import { evaluateQuota, type RejectionReason } from "./quotaEvaluator.js";
import { upsertAndLockCounter, incrementCounter, type CounterRow } from "./counterRepository.js";
import { computeRequestHash, type RequestFingerprint } from "../../utils/idempotency.js";
import { formatDateForDb, getUtcMonthStart } from "../../utils/date.js";
import { NotFoundError, BusinessError, ConflictError, ValidationError } from "../../errors/AppError.js";

export interface UsageInput {
  userId?: string;
  units: bigint;
  idempotencyKey: string;
}

export interface QuotaDecision {
  decision: "accepted" | "rejected";
  rejectionReason?: RejectionReason;
  accountRemaining: bigint;
  userRemaining?: bigint;
  periodStart: string;
}

export async function processUsageRequest(
  accountId: number,
  input: UsageInput,
  apiKeyId: number
): Promise<QuotaDecision> {
  // Validate idempotency key (structural validation, not business rule)
  if (!input.idempotencyKey || input.idempotencyKey.length === 0) {
    throw new ValidationError("Idempotency key is required");
  }
  if (input.idempotencyKey.length > 255) {
    throw new ValidationError("Idempotency key must not exceed 255 characters");
  }

  const periodStartDate = getUtcMonthStart();
  const periodStart = formatDateForDb(periodStartDate);

  const requestFingerprint: RequestFingerprint = {
    accountId,
    userId: input.userId ?? null,
    units: input.units.toString(),
  };
  const requestHash = computeRequestHash(requestFingerprint);

  return await withTransaction(async (tx) => {
    let userId: bigint | null = null;

    if (input.userId) {
      const user = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.accountId, BigInt(accountId)), eq(users.clientUserId, input.userId), isNull(users.deletedAt)))
        .limit(1)
        .execute();

      if (user.length === 0) {
        throw new NotFoundError("User not found in this account");
      }
      userId = user[0].id;
    }

    // CHECK IDEMPOTENCY FIRST - before quota evaluation
    // This allows us to return cached decision with original remaining quota
    const existing = await tx.execute(sql`
      SELECT id, account_id as "accountId", user_id as "userId", idempotency_key as "idempotencyKey", 
             request_hash as "requestHash", units, decision, rejection_reason as "rejectionReason", 
             period_start as "periodStart", account_remaining as "accountRemaining", 
             user_remaining as "userRemaining", created_at as "createdAt"
      FROM usage_requests
      WHERE account_id = ${BigInt(accountId)} AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `);

    if (existing.rows.length > 0) {
      const record = existing.rows[0] as {
        id: bigint;
        accountId: bigint;
        userId: bigint | null;
        idempotencyKey: string;
        requestHash: string;
        units: bigint;
        decision: string;
        rejectionReason: string | null;
        periodStart: string;
        accountRemaining: bigint | null;
        userRemaining: bigint | null;
        createdAt: Date;
      };
      if (record.requestHash !== requestHash) {
        throw new ConflictError("Idempotency key reused with different request data");
      }
      // Return cached decision with original remaining quota
      return {
        decision: record.decision as "accepted" | "rejected",
        rejectionReason: record.rejectionReason as RejectionReason | undefined,
        accountRemaining: record.accountRemaining ?? 0n,
        userRemaining: record.userRemaining ?? undefined,
        periodStart: record.periodStart,
      };
    }

    // No existing record - proceed with quota evaluation
    // Get or create counters (this locks the rows)
    const accountCounter = await upsertAndLockCounter(tx, BigInt(accountId), null, periodStart);
    let userCounter: CounterRow | null = null;
    if (userId !== null) {
      userCounter = await upsertAndLockCounter(tx, BigInt(accountId), userId, periodStart);
    }

    // Get current plan assignments
    const accountPlan = await getCurrentAccountPlan(tx, BigInt(accountId), periodStart);
    const userPlan = userId ? await getCurrentUserPlan(tx, BigInt(accountId), userId, periodStart) : null;

    if (!accountPlan) {
      throw new BusinessError("No active account plan assigned");
    }

    // Evaluate quota (handles all business rule validation including units <= 0, max per request)
    const evaluation = evaluateQuota({
      accountPlan: {
        monthlyAllowance: accountPlan.monthlyAllowance,
        maxUnitsPerRequest: accountPlan.maxUnitsPerRequest,
      },
      userPlan: userPlan
        ? {
            monthlyAllowance: userPlan.monthlyAllowance,
            maxUnitsPerRequest: userPlan.maxUnitsPerRequest,
          }
        : null,
      accountUsed: BigInt(accountCounter.counter),
      userUsed: userCounter ? BigInt(userCounter.counter) : 0n,
      requestedUnits: input.units,
    });

    // For rejected requests with units <= 0, we can't insert due to DB constraint
    // Just return the evaluation result without persisting (idempotency not supported for invalid units)
    if (input.units <= 0n) {
      return {
        decision: evaluation.decision,
        rejectionReason: evaluation.rejectionReason,
        accountRemaining: evaluation.accountRemaining,
        userRemaining: evaluation.userRemaining,
        periodStart,
      };
    }

    interface UsageRequestRow {
      id: bigint;
      accountId: bigint;
      userId: bigint | null;
      idempotencyKey: string;
      requestHash: string;
      units: bigint;
      decision: string;
      rejectionReason: string | null;
      periodStart: string;
      accountRemaining: bigint | null;
      userRemaining: bigint | null;
      createdAt: Date;
    }

    function mapRowToUsageRequest(row: Record<string, unknown>): UsageRequestRow {
      return {
        id: row.id as bigint,
        accountId: row.accountId as bigint,
        userId: (row.userId as bigint | null) ?? null,
        idempotencyKey: row.idempotencyKey as string,
        requestHash: row.requestHash as string,
        units: row.units as bigint,
        decision: row.decision as string,
        rejectionReason: row.rejectionReason as string | null,
        periodStart: row.periodStart as string,
        accountRemaining: (row.accountRemaining as bigint | null) ?? null,
        userRemaining: (row.userRemaining as bigint | null) ?? null,
        createdAt: row.createdAt as Date,
      };
    }

    // Insert the usage request with ON CONFLICT DO NOTHING to handle concurrent races
    // This doesn't abort the transaction on conflict
    const insertResult = await tx.execute(sql`
      INSERT INTO usage_requests (account_id, user_id, idempotency_key, request_hash, units, decision, rejection_reason, period_start, account_remaining, user_remaining)
      VALUES (${BigInt(accountId)}, ${userId}, ${input.idempotencyKey}, ${requestHash}, ${input.units}, ${evaluation.decision}, ${evaluation.rejectionReason ?? null}, ${periodStart}, ${evaluation.accountRemaining}, ${evaluation.userRemaining ?? null})
      ON CONFLICT (account_id, idempotency_key) DO NOTHING
      RETURNING id, account_id as "accountId", user_id as "userId", idempotency_key as "idempotencyKey", request_hash as "requestHash", units, decision, rejection_reason as "rejectionReason", period_start as "periodStart", account_remaining as "accountRemaining", user_remaining as "userRemaining", created_at as "createdAt"
    `);

    let requestRecord: UsageRequestRow | undefined;

    if (insertResult.rows.length > 0) {
      requestRecord = mapRowToUsageRequest(insertResult.rows[0]);
    }

    if (!requestRecord) {
      // Conflict - another concurrent request inserted the same key
      // Fetch the existing record and verify hash
      const existing = await tx.execute(sql`
        SELECT id, account_id as "accountId", user_id as "userId", idempotency_key as "idempotencyKey", 
               request_hash as "requestHash", units, decision, rejection_reason as "rejectionReason", 
               period_start as "periodStart", account_remaining as "accountRemaining", 
               user_remaining as "userRemaining", created_at as "createdAt"
        FROM usage_requests
        WHERE account_id = ${BigInt(accountId)} AND idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `);

      if (existing.rows.length > 0) {
        requestRecord = mapRowToUsageRequest(existing.rows[0]);
        if (requestRecord.requestHash !== requestHash) {
          throw new ConflictError("Idempotency key reused with different request data");
        }
        // Return cached decision with original remaining quota
        return {
          decision: requestRecord.decision as "accepted" | "rejected",
          rejectionReason: requestRecord.rejectionReason as RejectionReason | undefined,
          accountRemaining: requestRecord.accountRemaining ?? 0n,
          userRemaining: requestRecord.userRemaining ?? undefined,
          periodStart: requestRecord.periodStart,
        };
      }
      // Should not happen - conflict but no record found
      throw new ConflictError("Idempotency key conflict");
    }

    // We won the idempotency key - proceed with counter updates if accepted
    if (evaluation.decision === "accepted") {
      await incrementCounter(tx, accountCounter.id, input.units);
      if (userCounter !== null) {
        await incrementCounter(tx, userCounter.id, input.units);
      }
    }

    await tx.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, BigInt(apiKeyId)))
      .execute()
      .catch(() => {});

    return {
      decision: evaluation.decision,
      rejectionReason: evaluation.rejectionReason,
      accountRemaining: evaluation.accountRemaining,
      userRemaining: evaluation.userRemaining,
      periodStart,
    };
  }, { maxRetries: 3, baseDelayMs: 50 });
}

async function getCurrentAccountPlan(
  tx: Transaction,
  accountId: bigint,
  periodStart: string
): Promise<{ monthlyAllowance: bigint; maxUnitsPerRequest: bigint } | null> {
  const assignment = await tx
    .select({
      planId: planAssignments.planId,
      monthlyAllowance: plans.monthlyAllowance,
      maxUnitsPerRequest: plans.maxUnitsPerRequest,
    })
    .from(planAssignments)
    .innerJoin(plans, eq(planAssignments.planId, plans.id))
    .where(
      and(
        eq(planAssignments.accountId, accountId),
        isNull(planAssignments.userId),
        isNull(planAssignments.effectiveTo),
        eq(plans.isActive, true),
        isNull(plans.deletedAt),
        sql`${planAssignments.effectiveFrom}::date <= ${periodStart}::date`
      )
    )
    .limit(1)
    .execute();

  if (assignment.length === 0) return null;

  return {
    monthlyAllowance: BigInt(assignment[0].monthlyAllowance),
    maxUnitsPerRequest: BigInt(assignment[0].maxUnitsPerRequest),
  };
}

async function getCurrentUserPlan(
  tx: Transaction,
  accountId: bigint,
  userId: bigint,
  periodStart: string
): Promise<{ monthlyAllowance: bigint; maxUnitsPerRequest: bigint } | null> {
  const assignment = await tx
    .select({
      planId: planAssignments.planId,
      monthlyAllowance: plans.monthlyAllowance,
      maxUnitsPerRequest: plans.maxUnitsPerRequest,
    })
    .from(planAssignments)
    .innerJoin(plans, eq(planAssignments.planId, plans.id))
    .where(
      and(
        eq(planAssignments.accountId, accountId),
        eq(planAssignments.userId, userId),
        isNull(planAssignments.effectiveTo),
        eq(plans.isActive, true),
        isNull(plans.deletedAt),
        sql`${planAssignments.effectiveFrom}::date <= ${periodStart}::date`
      )
    )
    .limit(1)
    .execute();

  if (assignment.length === 0) return null;

  return {
    monthlyAllowance: BigInt(assignment[0].monthlyAllowance),
    maxUnitsPerRequest: BigInt(assignment[0].maxUnitsPerRequest),
  };
}