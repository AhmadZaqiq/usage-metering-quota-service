import type { Transaction } from "../../db/client.js";
import type { PlanQuota } from "../../domain/quotaEvaluator.js";
import { upsertAndLockCounter, type CounterRow } from "../../infrastructure/repositories/counterRepository.js";
import { selectUserByAccountAndClientUserId } from "../../infrastructure/repositories/userRepository.js";
import { selectCurrentAssignmentByAccount, selectCurrentAssignmentByUser, selectPlanByCriteria } from "../../infrastructure/repositories/assignmentRepository.js";
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
): Promise<UsageContext> {
  const accountCounter = await upsertAndLockCounter(tx, accountId, null, periodStart);
  const userCounter =
    userId !== null ? await upsertAndLockCounter(tx, accountId, userId, periodStart) : null;

  const accountAssignment = await selectCurrentAssignmentByAccount(tx, accountId);
  const userAssignment = userId ? await selectCurrentAssignmentByUser(tx, userId) : null;

  const accountPlan = accountAssignment
    ? await selectPlanByCriteria(tx, accountAssignment.planId)
    : null;
  const userPlan = userAssignment ? await selectPlanByCriteria(tx, userAssignment.planId) : null;

  if (!accountPlan) {
    // Missing plan configuration is a state conflict (409), not a client
    // input error; failing closed also prevents consuming without policy.
    throw new ConflictError("No active account plan assigned");
  }

  // Fail closed for user-scoped requests: a user without an effective user
  // plan must not silently fall back to account-only quota (fail-open).
  if (userId !== null && (!userAssignment || !userPlan)) {
    throw new ConflictError("No active user plan assigned for user");
  }

  return {
    userId,
    accountCounter,
    userCounter,
    accountPlanQuota: {
      monthlyAllowance: accountPlan.monthlyAllowance,
      maxUnitsPerRequest: accountPlan.maxUnitsPerRequest,
    },
    userPlanQuota: userPlan
      ? {
          monthlyAllowance: userPlan.monthlyAllowance,
          maxUnitsPerRequest: userPlan.maxUnitsPerRequest,
        }
      : null,
  };
}
