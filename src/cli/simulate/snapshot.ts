import { ApiClient } from '../apiClient.js';
import { fetchCurrentAssignments, fetchHistory, fetchPlans, fetchUsers } from './api.js';
import { expect } from './guard.js';
import type { AssignmentDto, PlanDto, UsageHistoryItemDto, UserDto } from './types.js';

/**
 * Fresh read model assembled from GET endpoints: plans, users, current
 * assignments, and the latest recorded usage row (account-wide and per
 * user). Callers must re-load on every menu render — balances are labeled
 * with the row they came from because plan changes are not reflected until
 * the next request.
 */

export interface UserSnapshot {
  user: UserDto;
  assignment: AssignmentDto | null;
  plan: PlanDto | null;
  /** Newest history row for this user (after that request), or null. */
  latest: UsageHistoryItemDto | null;
}

export interface Snapshot {
  plans: PlanDto[];
  users: UserDto[];
  current: AssignmentDto | null;
  currentUsers: AssignmentDto[];
  accountPlan: PlanDto | null;
  /** Newest history row for the account (after that request), or null. */
  accountLatest: UsageHistoryItemDto | null;
  userSnapshots: UserSnapshot[];
}

export async function loadSnapshot(api: ApiClient): Promise<Snapshot> {
  const plans = expect(await fetchPlans(api), 200, 'list plans');
  const users = expect(await fetchUsers(api), 200, 'list users');
  const current = expect(await fetchCurrentAssignments(api), 200, 'read current assignments');
  const history = expect(await fetchHistory(api, { limit: 1 }), 200, 'read latest usage row');

  const userSnapshots: UserSnapshot[] = [];
  for (const user of users) {
    // Balances are fetched only for company users: demo runs accumulate many
    // demo-* users and a per-user request for each would slow every render.
    const latest = isSimcoUser(user.clientUserId)
      ? expect(
          await fetchHistory(api, { userId: user.clientUserId, limit: 1 }),
          200,
          `read history for ${user.clientUserId}`
        ).items[0] ?? null
      : null;
    const assignment = current.users.find((a) => a.userId === user.id) ?? null;
    const plan = assignment === null ? null : plans.find((p) => p.id === assignment.planId) ?? null;
    userSnapshots.push({ user, assignment, plan, latest });
  }

  const accountAssignment = current.account;
  const accountPlan =
    accountAssignment === null
      ? null
      : plans.find((p) => p.id === accountAssignment.planId) ?? null;

  return {
    plans,
    users,
    current: accountAssignment,
    currentUsers: current.users,
    accountPlan,
    accountLatest: history.items[0] ?? null,
    userSnapshots,
  };
}

export function isSimcoUser(clientUserId: string): boolean {
  return clientUserId.startsWith('simco-');
}

/** Remaining quota from the latest row, or null when nothing was recorded. */
export function remainingOf(
  row: UsageHistoryItemDto | null,
  scope: 'account' | 'user'
): string | null {
  if (row === null) return null;
  return scope === 'account' ? row.accountRemaining : row.userRemaining;
}
