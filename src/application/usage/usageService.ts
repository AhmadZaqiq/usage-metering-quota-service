import { withTransaction } from "../../db/client.js";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../../config/index.js";
import { evaluateQuota, type QuotaResult, type RejectionReason, type LimitScope } from "../../domain/quotaEvaluator.js";
import { computeRequestHash } from "../../domain/idempotency.js";
import { formatDateForDb, getUtcMonthStart } from "../../domain/date.js";
import { ValidationError, ConflictError } from "../../errors/AppError.js";
import { resolveUserId, resolveUsageContext } from "./resolveUsageContext.js";
import { findReplayDecision } from "./replayUsageRequest.js";
import { persistUsageDecision } from "./persistUsageDecision.js";

export interface UsageInput {
  userId?: string;
  units: bigint;
  idempotencyKey: string;
}

export interface QuotaDecision {
  decision: "accepted" | "rejected";
  rejectionReason?: RejectionReason;
  /** Only set when rejectionReason is `max_per_request_exceeded`. */
  limitScope?: LimitScope;
  accountRemaining: bigint;
  userRemaining?: bigint;
  periodStart: string;
}

/**
 * Process one usage request end to end inside a single transaction:
 *
 *   resolve user -> idempotent replay check -> lock counters + resolve plans
 *   -> evaluate quota -> persist decision (+ counters, + last-used stamp)
 *
 * Replays return the originally committed decision without re-evaluating
 * quota or taking counter locks; concurrent duplicates converge on the
 * winner's decision via ON CONFLICT DO NOTHING plus a re-read.
 */
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

  const requestHash = computeRequestHash({
    accountId,
    userId: input.userId ?? null,
    units: input.units.toString(),
  });

  return await withTransaction(async (tx) => {
    const userId = await resolveUserId(tx, BigInt(accountId), input.userId);

    // Check idempotency first - before quota evaluation - so a replay returns
    // the cached decision with the original remaining quota.
    const replay = await findReplayDecision(
      tx,
      BigInt(accountId),
      input.idempotencyKey,
      requestHash
    );
    if (replay) {
      return replay;
    }

    const context = await resolveUsageContext(
      tx,
      BigInt(accountId),
      userId,
      periodStart
    );

    const evaluation = evaluateQuota({
      accountPlan: context.accountPlanQuota,
      userPlan: context.userPlanQuota,
      accountUsed: BigInt(context.accountCounter.counter),
      userUsed: context.userCounter ? BigInt(context.userCounter.counter) : 0n,
      requestedUnits: input.units,
      maxUnitsPerRequestLimit: MAX_UNITS_PER_REQUEST_BIGINT,
    });

    // Rejected requests with units <= 0 cannot be inserted (DB CHECK
    // chk_usage_request_units_positive). Return the decision without
    // persisting; idempotency is not supported for invalid units.
    if (input.units <= 0n) {
      return toLiveDecision(evaluation, periodStart);
    }

    const stored = await persistUsageDecision(tx, {
      accountId: BigInt(accountId),
      userId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      units: input.units,
      evaluation,
      periodStart,
      accountCounterId: context.accountCounter.id,
      userCounterId: context.userCounter?.id ?? null,
      apiKeyId: BigInt(apiKeyId),
    });

    if (!stored) {
      // Lost the idempotency race: converge on the winner's committed
      // decision instead of double-counting.
      const raced = await findReplayDecision(
        tx,
        BigInt(accountId),
        input.idempotencyKey,
        requestHash
      );
      if (!raced) {
        // Conflict observed but no record visible - should not happen.
        throw new ConflictError("Idempotency key conflict");
      }
      return raced;
    }

    return toLiveDecision(evaluation, periodStart);
  }, { maxRetries: 3, baseDelayMs: 50 });
}

/** Map a live evaluation to the response DTO, attaching the period. */
function toLiveDecision(evaluation: QuotaResult, periodStart: string): QuotaDecision {
  return {
    decision: evaluation.decision,
    rejectionReason: evaluation.rejectionReason,
    limitScope: evaluation.limitScope,
    accountRemaining: evaluation.accountRemaining,
    userRemaining: evaluation.userRemaining,
    periodStart,
  };
}
