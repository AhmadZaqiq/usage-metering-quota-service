import { withTransaction } from "../../db/client.js";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../../config/index.js";
import { evaluateQuota, type QuotaResult, type RejectionReason, type LimitScope } from "../../domain/quotaEvaluator.js";
import { computeRequestHash } from "../../domain/idempotency.js";
import { formatDateForDb, getUtcMonthStart } from "../../domain/date.js";
import { ValidationError, ConflictError, NotFoundError } from "../../errors/AppError.js";
import { lockAccountForAdmission, readClockTimestamp } from "../../infrastructure/repositories/accountRepository.js";
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

export interface UsageRequestOptions {
  /**
   * Test seam: supplies the admission timestamp (ISO-8601, UTC) that decides
   * both the quota period and the persisted created_at metadata. Defaults to
   * the database clock (`clock_timestamp()`) sampled after the account row
   * lock is granted, so the timestamp observes the moment of admission, not
   * the moment the request started waiting.
   */
  admissionTimestamp?: () => string;
}

/**
 * Process one usage request end to end inside a single transaction:
 *
 *   resolve user -> idempotent replay check -> lock the account row (admission
 *   lock) -> sample the admission clock -> lock counters + resolve plans
 *   -> evaluate quota -> persist decision (+ counters, + last-used stamp)
 *
 * The admission timestamp is sampled only after the period-independent
 * account row lock is granted, so a request queued across a UTC month
 * boundary is attributed to the month in which it is admitted. Lock order:
 * accounts row -> account counter -> user counter -> api key row.
 *
 * Replays return the originally committed decision without re-evaluating
 * quota or taking counter locks; concurrent duplicates converge on the
 * winner's decision via ON CONFLICT DO NOTHING plus a re-read.
 */
export async function processUsageRequest(
  accountId: number,
  input: UsageInput,
  apiKeyId: number,
  options?: UsageRequestOptions
): Promise<QuotaDecision> {
  // Validate idempotency key (structural validation, not business rule)
  if (!input.idempotencyKey || input.idempotencyKey.length === 0) {
    throw new ValidationError("Idempotency key is required");
  }
  if (input.idempotencyKey.length > 255) {
    throw new ValidationError("Idempotency key must not exceed 255 characters");
  }

  const requestHash = computeRequestHash({
    accountId,
    userId: input.userId ?? null,
    units: input.units.toString(),
  });

  return await withTransaction(async (tx) => {
    const userId = await resolveUserId(tx, BigInt(accountId), input.userId);

    // Check idempotency first - before quota evaluation - so a replay returns
    // the cached decision with the original remaining quota. The replay path
    // needs no locks and no clock: it answers from the stored row.
    const replay = await findReplayDecision(
      tx,
      BigInt(accountId),
      input.idempotencyKey,
      requestHash
    );
    if (replay) {
      return replay;
    }

    // Period-independent admission lock, then the admission clock. This
    // ordering is the month-boundary invariant: the timestamp that picks the
    // period is observed while holding the lock that serializes the account.
    const locked = await lockAccountForAdmission(tx, BigInt(accountId));
    if (!locked) {
      throw new NotFoundError("Account not found");
    }
    const admissionIso = options?.admissionTimestamp
      ? options.admissionTimestamp()
      : await readClockTimestamp(tx);
    const periodStart = formatDateForDb(getUtcMonthStart(new Date(admissionIso)));

    const context = await resolveUsageContext(
      tx,
      BigInt(accountId),
      userId,
      periodStart,
      admissionIso
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
      createdAt: admissionIso,
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
