import { withTransaction } from "../../db/client.js";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../../config/index.js";
import { evaluateQuota, type RejectionReason } from "./quotaEvaluator.js";
import { upsertAndLockCounter, incrementCounter, type CounterRow } from "./counterRepository.js";
import { computeRequestHash, type RequestFingerprint } from "../../utils/idempotency.js";
import { formatDateForDb, getUtcMonthStart } from "../../utils/date.js";
import { NotFoundError, BusinessError, ConflictError, ValidationError } from "../../errors/AppError.js";
import { findUsageRequestByKey, insertUsageRequest, type UsageRequestRow } from "./usageRequestRepository.js";
import { selectUserByAccountAndClientUserId } from "../users/userRepository.js";
import { selectCurrentAssignmentByAccount, selectCurrentAssignmentByUser, selectPlanByCriteria } from "../plans/assignmentRepository.js";
import { updateApiKeyLastUsedAt } from "../auth/apiKeyRepository.js";

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
      const user = await selectUserByAccountAndClientUserId(tx, BigInt(accountId), input.userId);

      if (!user) {
        throw new NotFoundError("User not found in this account");
      }
      userId = user.id;
    }

    // CHECK IDEMPOTENCY FIRST - before quota evaluation
    // This allows us to return cached decision with original remaining quota
    const existing = await findUsageRequestByKey(tx, BigInt(accountId), input.idempotencyKey);

    if (existing.length > 0) {
      const record = existing[0];
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
    const accountAssignment = await selectCurrentAssignmentByAccount(tx, BigInt(accountId));
    const userAssignment = userId ? await selectCurrentAssignmentByUser(tx, userId) : null;

    // Resolve plan quota details from assignments
    const accountPlanResult = accountAssignment ? await selectPlanByCriteria(tx, accountAssignment.planId) : null;
    const userPlanResult = userAssignment ? await selectPlanByCriteria(tx, userAssignment.planId) : null;

    if (!accountPlanResult) {
      throw new BusinessError("No active account plan assigned");
    }

    const accountPlanQuota = {
      monthlyAllowance: accountPlanResult.monthlyAllowance,
      maxUnitsPerRequest: accountPlanResult.maxUnitsPerRequest,
    };

    const userPlanQuota = userPlanResult ? {
      monthlyAllowance: userPlanResult.monthlyAllowance,
      maxUnitsPerRequest: userPlanResult.maxUnitsPerRequest,
    } : null;

    // Evaluate quota (handles all business rule validation including units <= 0, max per request)
    const evaluation = evaluateQuota({
      accountPlan: accountPlanQuota,
      userPlan: userPlanQuota,
      accountUsed: BigInt(accountCounter.counter),
      userUsed: userCounter ? BigInt(userCounter.counter) : 0n,
      requestedUnits: input.units,
      maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
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

    // Insert the usage request with ON CONFLICT DO NOTHING to handle concurrent races
    // This doesn't abort the transaction on conflict
    const insertResult = await insertUsageRequest(
      tx,
      BigInt(accountId),
      userId,
      input.idempotencyKey,
      requestHash,
      input.units,
      evaluation.decision,
      evaluation.rejectionReason ?? null,
      periodStart,
      evaluation.accountRemaining,
      evaluation.userRemaining ?? null,
    );

    let requestRecord: UsageRequestRow | undefined;

    if (insertResult.length > 0) {
      requestRecord = insertResult[0];
    }

    if (!requestRecord) {
      // Conflict - another concurrent request inserted the same key
      // Fetch the existing record and verify hash
      const existing = await findUsageRequestByKey(tx, BigInt(accountId), input.idempotencyKey);

      if (existing.length > 0) {
        requestRecord = existing[0];
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

    await updateApiKeyLastUsedAt(tx, BigInt(apiKeyId));

    return {
      decision: evaluation.decision,
      rejectionReason: evaluation.rejectionReason,
      accountRemaining: evaluation.accountRemaining,
      userRemaining: evaluation.userRemaining,
      periodStart,
    };
  }, { maxRetries: 3, baseDelayMs: 50 });
}
