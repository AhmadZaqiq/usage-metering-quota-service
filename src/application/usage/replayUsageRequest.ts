import type { Transaction } from "../../db/client.js";
import type { RejectionReason } from "../../domain/quotaEvaluator.js";
import { findUsageRequestByKey } from "../../infrastructure/repositories/usageRequestRepository.js";
import { ConflictError } from "../../errors/AppError.js";
import type { QuotaDecision } from "./usageService.js";

/**
 * Look up a previously committed decision for this idempotency key, if any.
 * Returns null when the key has not been seen; otherwise the original
 * decision with its originally persisted remainings.
 *
 * Throws a conflict when the key was used with different semantic input
 * (hash mismatch), on both the pre-check and the post-insert race path.
 *
 * `limitScope` is intentionally omitted here: it is not persisted (no
 * column), so a replay cannot recover it without re-evaluating quota, which
 * would defeat the point of a stable cached result.
 */
export async function findReplayDecision(
  tx: Transaction,
  accountId: bigint,
  idempotencyKey: string,
  requestHash: string,
): Promise<QuotaDecision | null> {
  const existing = await findUsageRequestByKey(tx, accountId, idempotencyKey);
  if (existing.length === 0) {
    return null;
  }

  const record = existing[0];
  if (record.requestHash !== requestHash) {
    throw new ConflictError("Idempotency key reused with different request data");
  }

  return {
    decision: record.decision as "accepted" | "rejected",
    rejectionReason: record.rejectionReason as RejectionReason | undefined,
    accountRemaining: record.accountRemaining ?? 0n,
    userRemaining: record.userRemaining ?? undefined,
    periodStart: record.periodStart,
  };
}
