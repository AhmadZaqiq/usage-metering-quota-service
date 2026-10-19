import { DemoError } from '../../apiClient.js';
import {
  createAssignment,
  fetchCurrentAssignments,
  fetchHistory,
  fetchPlans,
  fetchUsers,
  patchPlan,
  postUsage,
} from '../api.js';
import { expect } from '../guard.js';
import { printChanged, printError, printNote } from '../present.js';
import { activateSimcoAccountPlan } from '../setup.js';
import type { Snapshot, UserSnapshot } from '../snapshot.js';
import type { PlanDto, UserDto } from '../types.js';
import type { SimContext } from '../context.js';

/**
 * Scenario mechanics shared by the guided scenarios. Every helper works from
 * live service state and announces the persistent changes it makes.
 */

/** Transient measurement ceiling: high enough that the probe always accepts. */
const PRIME_ALLOWANCE = '1000000';
/** Headroom every user-scoped scenario needs from the shared account pool. */
const ACCOUNT_POOL_HEADROOM = '2000';
/** Recent rows proving at least this much account headroom skip re-priming. */
const ACCOUNT_POOL_MIN = 500n;

/**
 * Force `plan` to leave exactly `headroom` units of remaining quota — from
 * any starting state and without reading the database:
 *   1. raise the allowance to PRIME_ALLOWANCE (so the probe cannot reject),
 *   2. probe 1 unit; the response's remaining reveals exact month usage
 *      (used = PRIME_ALLOWANCE - remaining),
 *   3. set allowance := used + headroom, so remaining is exactly headroom.
 * The probe is a real request and is recorded in history like any other.
 *
 * For user scope the account pool is primed first: account quota is evaluated
 * before user quota, so an exhausted account would reject the probe even when
 * the user plan itself has plenty of room.
 */
export async function primeAllowance(
  ctx: SimContext,
  plan: PlanDto,
  scope: 'account' | 'user',
  headroom: string,
  userId?: string
): Promise<{ used: string }> {
  if (scope === 'user') {
    await primeAccountPool(ctx);
  }

  expect(
    await patchPlan(ctx.api, plan.id, { monthlyAllowance: PRIME_ALLOWANCE }),
    200,
    `raise ${plan.name}`
  );

  const probe = await postUsage(
    ctx.api,
    { units: '1', requestId: ctx.nextRequestId('probe'), ...(userId ? { userId } : {}) }
  );
  if (probe.status !== 200 || probe.data.decision !== 'accepted') {
    // Roll back the transient raise so a failed prime never leaves the plan
    // sitting at PRIME_ALLOWANCE.
    await patchPlan(ctx.api, plan.id, { monthlyAllowance: plan.monthlyAllowance }).catch(() => undefined);
    if (probe.status !== 200) printError(probe.status, probe.data);
    const reason =
      probe.status === 200
        ? String(probe.data.rejectionReason ?? 'rejected')
        : `HTTP ${probe.status}`;
    const hint =
      reason === 'account_quota_exceeded'
        ? ' — the account pool is exhausted; activate the mutable SimCo account plan (menu 7) and retry'
        : '';
    throw new DemoError(`probe failed (${reason}) while priming ${plan.name}${hint}`);
  }

  const remainingRaw =
    scope === 'account' ? probe.data.accountRemaining : probe.data.userRemaining;
  if (remainingRaw === undefined) {
    throw new DemoError(`probe response missing ${scope}Remaining — cannot measure usage`);
  }
  const used = BigInt(PRIME_ALLOWANCE) - BigInt(remainingRaw);
  const next = used + BigInt(headroom);
  const patched = expect(
    await patchPlan(ctx.api, plan.id, { monthlyAllowance: next.toString() }),
    200,
    `set ${plan.name} allowance`
  );
  printChanged(
    `${patched.name}: allowance set to ${next} (usage ${used} + headroom ${headroom}) → ${scope} remaining is exactly ${headroom}`
  );
  return { used: used.toString() };
}

/**
 * Give the shared account pool headroom before a user-scoped prime.
 * Custom account plans are primed like any other plan; system plans are
 * immutable, so the existing remaining is relied upon and the probe reports
 * the truth if it is not enough.
 */
async function primeAccountPool(ctx: SimContext): Promise<void> {
  const current = expect(await fetchCurrentAssignments(ctx.api), 200, 'read current assignments');
  const assignment = current.account;
  if (assignment === null) {
    throw new DemoError('no account plan assigned — activate one via menu 7 first');
  }
  // The newest recorded row is proof enough when the pool already covers a
  // scenario's handful of requests — skips most re-priming (5 requests).
  const latest = expect(await fetchHistory(ctx.api, { limit: 1 }), 200, 'read latest usage row').items[0];
  const remaining = latest?.accountRemaining;
  if (remaining !== undefined && remaining !== null && BigInt(remaining) >= ACCOUNT_POOL_MIN) {
    return;
  }
  const plans = expect(await fetchPlans(ctx.api), 200, 'list plans');
  const plan = plans.find((p) => p.id === assignment.planId);
  if (plan === undefined) {
    throw new DemoError(`current account plan ${assignment.planName} not found in plan list`);
  }
  if (plan.ownerAccountId === null) {
    printNote(
      `${plan.name} is a system plan (immutable) — relying on its remaining; activate the SimCo account plan if the probe rejects`
    );
    return;
  }
  await primeAllowance(ctx, plan, 'account', ACCOUNT_POOL_HEADROOM);
}

export async function restoreAllowance(ctx: SimContext, planId: number, allowance: string, name: string): Promise<void> {
  expect(await patchPlan(ctx.api, planId, { monthlyAllowance: allowance }), 200, `restore ${name}`);
  printChanged(`restored ${name} allowance to ${allowance}`);
}

/** Assign `planName` to `clientUserId` when it is not already current. */
export async function ensureUserOnPlan(
  ctx: SimContext,
  clientUserId: string,
  planId: number,
  planName: string
): Promise<boolean> {
  const users = expect(await fetchUsers(ctx.api), 200, 'list users');
  const user = users.find((u: UserDto) => u.clientUserId === clientUserId);
  if (user === undefined) {
    throw new DemoError(`user ${clientUserId} not found in this account`);
  }
  const current = expect(await fetchCurrentAssignments(ctx.api), 200, 'read current assignments');
  const assignment = current.users.find((a) => a.userId === user.id);
  if (assignment?.planId === planId) return false;
  expect(
    await createAssignment(ctx.api, { userId: clientUserId, planId }),
    201,
    `assign ${planName} to ${clientUserId}`
  );
  printChanged(`assigned ${planName} to ${clientUserId} (effective on the next request)`);
  return true;
}

/**
 * Scenarios that need a small mutable account allowance require the SimCo
 * account plan; ask once, activate only after consent.
 */
export async function ensureSimcoAccountPlan(ctx: SimContext): Promise<void> {
  const current = expect(await fetchCurrentAssignments(ctx.api), 200, 'read current assignments');
  if (current.account?.planId === ctx.world.accountPlan.id) return;
  const label = current.account?.planName ?? 'no account plan';
  const proceed = await ctx.menu.yesNo(
    `This scenario needs the mutable "${ctx.world.accountPlan.name}" (currently: ${label}). Activate it now?`,
    true
  );
  if (!proceed) {
    throw new DemoError('scenario skipped: SimCo account plan not activated');
  }
  await activateSimcoAccountPlan(ctx.api, ctx.world.accountPlan.id);
}

/** SimCo users are created by setup; a missing one means setup never ran. */
export function requireSimcoUser(snap: Snapshot, clientUserId: string): UserSnapshot {
  const found = snap.userSnapshots.find((s) => s.user.clientUserId === clientUserId);
  if (found === undefined) {
    throw new DemoError(`missing SimCo user ${clientUserId} — run setup first`);
  }
  return found;
}
