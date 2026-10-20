import type { Transaction } from "../../db/client.js";
import type { PlanQuota } from "../../domain/quotaEvaluator.js";
import { upsertAndLockCounter, type CounterRow } from "../../infrastructure/repositories/counterRepository.js";
import { selectUserByAccountAndClientUserId } from "../../infrastructure/repositories/userRepository.js";
import {
  selectCurrentPlanQuotaByAccount,
  selectCurrentPlanQuotaByUser,
} from "../../infrastructure/repositories/assignmentRepository.js";
import { NotFoundError, ConflictError } from "../../errors/AppError.js";

export interface UsageContext {
  userId: bigint | null;
  /** Locked for the rest of the transaction (account-level, period row). */
  accountCounter: CounterRow;
  /** Locked when the request is user-scoped; null for account-level requests. */
  userCounter: CounterRow | null;
  accountPlanQuota: PlanQuota;
  userPlanQuota: PlanQuota | null;
}

/**
 * Resolve the internal user id for a client-supplied user id, enforcing that
 * the user belongs to the authenticated account. Runs before the idempotency
 * pre-check so a request naming a foreign/unknown user fails the same way on
 * replay as on first evaluation.
 */
export async function resolveUserId(
  tx: Transaction,
  accountId: bigint,
  clientUserId: string | undefined,
): Promise<bigint | null> {
  if (!clientUserId) {
    return null;
  }

  const user = await selectUserByAccountAndClientUserId(tx, accountId, clientUserId);
  if (!user) {
    throw new NotFoundError("User not found in this account");
  }
  return user.id;
}

/**
 * Lock the account (and user) counter rows for the current period, then
 * resolve the effective plan quotas. Lock ordering is account counter before
 * user counter, matching every other writer in the system.
 *
 * Fails closed: a request without an effective account plan, or a user-scoped
 * request without an effective user plan, is a state conflict (409) — never a
 * silent fallback to a less restrictive policy.
 */
export async function resolveUsageContext(
  tx: Transaction,
  accountId: bigint,
  userId: bigint | null,
  periodStart: string,
  createdAt: string,
): Promise<UsageContext> {
  const accountCounter = await upsertAndLockCounter(tx, accountId, null, periodStart, createdAt);
  const userCounter =
    userId !== null ? await upsertAndLockCounter(tx, accountId, userId, periodStart, createdAt) : null;

  // One statement per scope instead of separate assignment + plan lookups:
  // same predicates and filters, fewer round trips and planner runs inside
  // the serialized section of the transaction.
  const accountQuota = await selectCurrentPlanQuotaByAccount(tx, accountId);
  const userQuota = userId ? await selectCurrentPlanQuotaByUser(tx, userId) : null;

  if (!accountQuota) {
    // Missing plan configuration is a state conflict (409), not a client
    // input error; failing closed also prevents consuming without policy.
    // Covers both "no current assignment" and "assigned plan unusable".
    throw new ConflictError("No active account plan assigned");
  }

  // Fail closed for user-scoped requests: a user without an effective user
  // plan must not silently fall back to account-only quota (fail-open).
  if (userId !== null && !userQuota) {
    throw new ConflictError("No active user plan assigned for user");
  }

  return {
    userId,
    accountCounter,
    userCounter,
    accountPlanQuota: {
      monthlyAllowance: accountQuota.monthlyAllowance,
      maxUnitsPerRequest: accountQuota.maxUnitsPerRequest,
    },
    userPlanQuota: userQuota
      ? {
          monthlyAllowance: userQuota.monthlyAllowance,
          maxUnitsPerRequest: userQuota.maxUnitsPerRequest,
        }
      : null,
  };
}
