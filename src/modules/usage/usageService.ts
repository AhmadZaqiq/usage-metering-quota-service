import { db, withTransaction, type Transaction } from "../../db/client.js";
import { usageRequests, accounts, users, plans, planAssignments, apiKeys } from "../../db/schema/index.js";
import { eq, and, isNull, sql, or } from "drizzle-orm";
import { evaluateQuota, type QuotaInput, type QuotaResult, type RejectionReason } from "./quotaEvaluator.js";
import { upsertAndLockCounter, incrementCounter, type CounterRow } from "./counterRepository.js";
import { computeRequestHash, type RequestFingerprint } from "../../utils/idempotency.js";
import { formatDateForDb, getUtcMonthStart } from "../../utils/date.js";
import { NotFoundError, BusinessError, ConflictError } from "../../errors/AppError.js";

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

function buildDecisionFromRecord(record: {
  decision: string;
  rejectionReason: string | null;
  units: bigint;
  periodStart: string;
}): QuotaDecision {
  return {
    decision: record.decision as "accepted" | "rejected",
    rejectionReason: record.rejectionReason as RejectionReason | undefined,
    accountRemaining: 0n,
    userRemaining: undefined,
    periodStart: record.periodStart,
  };
}

export async function processUsageRequest(
  accountId: number,
  input: UsageInput,
  apiKeyId: number
): Promise<QuotaDecision> {
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

    // Check for existing idempotency key first
    const existing = await tx
      .select()
      .from(usageRequests)
      .where(and(eq(usageRequests.accountId, BigInt(accountId)), eq(usageRequests.idempotencyKey, input.idempotencyKey)))
      .limit(1)
      .execute();

    if (existing.length > 0) {
      const record = existing[0];
      if (record.requestHash !== requestHash) {
        throw new ConflictError("Idempotency key reused with different request data");
      }
      return buildDecisionFromRecord(record);
    }

    // No existing record - evaluate quota and insert final decision
    const accountCounter = await upsertAndLockCounter(tx, BigInt(accountId), 0n, periodStart);
    let userCounter: CounterRow | null = null;
    if (userId) {
      userCounter = await upsertAndLockCounter(tx, BigInt(accountId), userId, periodStart);
    }

    const accountPlan = await getCurrentAccountPlan(tx, BigInt(accountId), periodStart);
    const userPlan = userId ? await getCurrentUserPlan(tx, userId, periodStart) : null;

    if (!accountPlan) {
      throw new BusinessError("No active account plan assigned");
    }
    if (userId && !userPlan) {
      throw new BusinessError("No active user plan assigned");
    }

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
      accountUsed: accountCounter.counter,
      userUsed: userCounter?.counter ?? 0n,
      requestedUnits: input.units,
    });

    // Insert the final decision
    const [requestRecord] = await tx
      .insert(usageRequests)
      .values({
        accountId: BigInt(accountId),
        userId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        units: input.units,
        decision: evaluation.decision,
        rejectionReason: evaluation.rejectionReason ?? null,
        periodStart,
      })
      .returning()
      .execute();

    if (evaluation.decision === "accepted") {
      await incrementCounter(tx, accountCounter.id, input.units);
      if (userCounter) {
        await incrementCounter(tx, userCounter.id, input.units);
      }
    }

    tx.update(apiKeys)
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
        sql`${planAssignments.effectiveFrom} <= ${periodStart}::timestamptz`
      )
    )
    .limit(1)
    .execute();

  if (assignment.length === 0) return null;

  return {
    monthlyAllowance: assignment[0].monthlyAllowance,
    maxUnitsPerRequest: assignment[0].maxUnitsPerRequest,
  };
}

async function getCurrentUserPlan(
  tx: Transaction,
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
        eq(planAssignments.userId, userId),
        isNull(planAssignments.effectiveTo),
        eq(plans.isActive, true),
        isNull(plans.deletedAt),
        sql`${planAssignments.effectiveFrom} <= ${periodStart}::timestamptz`
      )
    )
    .limit(1)
    .execute();

  if (assignment.length === 0) return null;

  return {
    monthlyAllowance: assignment[0].monthlyAllowance,
    maxUnitsPerRequest: assignment[0].maxUnitsPerRequest,
  };
}