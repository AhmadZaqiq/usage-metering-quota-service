import type { Transaction } from "../../db/client.js";
import type { QuotaResult } from "../../domain/quotaEvaluator.js";
import { incrementCounter } from "../../infrastructure/repositories/counterRepository.js";
import { insertUsageRequest } from "../../infrastructure/repositories/usageRequestRepository.js";
import { updateApiKeyLastUsedAt } from "../../infrastructure/repositories/apiKeyRepository.js";

export interface PersistUsageDecisionInput {
  accountId: bigint;
  userId: bigint | null;
  idempotencyKey: string;
  requestHash: string;
  units: bigint;
  evaluation: QuotaResult;
  periodStart: string;
  /** Admission timestamp (ISO-8601, UTC); persisted as the row's created_at. */
  createdAt: string;
  /** Counter row ids already locked by resolveUsageContext. */
  accountCounterId: bigint;
  userCounterId: bigint | null;
  apiKeyId: bigint;
}

/**
 * Persist the decision and, when it is the first write for this idempotency
 * key, apply the side effects that must be atomic with it: counter
 * increments (accepted decisions only) and the API-key last-used stamp.
 *
 * The insert uses ON CONFLICT DO NOTHING so a concurrent duplicate does not
 * abort the transaction; losing the race returns false and the caller replays
 * the winner's committed decision instead of double-counting.
 */
export async function persistUsageDecision(
  tx: Transaction,
  input: PersistUsageDecisionInput,
): Promise<boolean> {
  const insertResult = await insertUsageRequest(
    tx,
    input.accountId,
    input.userId,
    input.idempotencyKey,
    input.requestHash,
    input.units,
    input.evaluation.decision,
    input.evaluation.rejectionReason ?? null,
    input.periodStart,
    input.evaluation.accountRemaining,
    input.evaluation.userRemaining ?? null,
    input.createdAt,
  );

  if (insertResult.length === 0) {
    // Another concurrent request inserted the same key first.
    return false;
  }

  if (input.evaluation.decision === "accepted") {
    await incrementCounter(tx, input.accountCounterId, input.units);
    if (input.userCounterId !== null) {
      await incrementCounter(tx, input.userCounterId, input.units);
    }
  }

  await updateApiKeyLastUsedAt(tx, input.apiKeyId);
  return true;
}
