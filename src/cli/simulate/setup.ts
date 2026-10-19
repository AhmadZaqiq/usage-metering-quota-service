import { ApiClient } from '../apiClient.js';
import {
  createAssignment,
  createPlan,
  createUser,
  fetchCurrentAssignments,
  fetchPlans,
  fetchUsers,
  patchPlan,
} from './api.js';
import { expect } from './guard.js';
import type { Prompter } from './menu.js';
import { printChanged, printNote, printOk } from './present.js';
import type { CurrentAssignmentsDto, PlanDto } from './types.js';

/**
 * The simulator's fictional company. Data is created through the public API
 * only and reused across runs: every step is read-before-write, so running
 * `simulate` twice never duplicates a user or plan.
 */

export const SIMCO_USERS = ['simco-ana', 'simco-bob', 'simco-cara'] as const;

export interface SimcoPlanSpec {
  name: string;
  type: 'account' | 'user';
  allowance: string;
  cap: string;
}

export const SIMCO_ACCOUNT_PLAN: SimcoPlanSpec = { name: 'SimCo Account Plan', type: 'account', allowance: '400', cap: '100' };
export const SIMCO_BASIC_PLAN: SimcoPlanSpec = { name: 'SimCo Basic', type: 'user', allowance: '100', cap: '50' };
export const SIMCO_PLUS_PLAN: SimcoPlanSpec = { name: 'SimCo Plus', type: 'user', allowance: '1000', cap: '100' };

export interface SimcoWorld {
  accountPlan: PlanDto;
  basicPlan: PlanDto;
  plusPlan: PlanDto;
  userIds: readonly string[];
  /** Account plan observed before any activation by this run (for restore on exit). */
  accountPlanAtStart: { id: number; name: string } | null;
}

/** Create-or-normalize one SimCo plan; returns the live plan row. */
async function ensurePlan(api: ApiClient, plans: PlanDto[], spec: SimcoPlanSpec): Promise<PlanDto> {
  const existing = plans.find((p) => p.name === spec.name && p.type === spec.type);
  if (!existing) {
    const created = expect(
      await createPlan(api, {
        name: spec.name,
        type: spec.type,
        monthlyAllowance: spec.allowance,
        maxUnitsPerRequest: spec.cap,
      }),
      201,
      `create ${spec.name}`
    );
    printChanged(`created plan ${spec.name} (allowance ${spec.allowance}, max/request ${spec.cap})`);
    return created;
  }

  if (existing.monthlyAllowance === spec.allowance && existing.maxUnitsPerRequest === spec.cap) {
    return existing;
  }
  const normalized = expect(
    await patchPlan(api, existing.id, {
      monthlyAllowance: spec.allowance,
      maxUnitsPerRequest: spec.cap,
    }),
    200,
    `normalize ${spec.name}`
  );
  printChanged(
    `normalized plan ${spec.name} to allowance ${spec.allowance} / max/request ${spec.cap}` +
      ' (a lower allowance clamps remaining quota at 0)'
  );
  return normalized;
}

function assignCurrent(
  current: CurrentAssignmentsDto,
  userIdInternal: number | undefined
): number | undefined {
  const assignment =
    userIdInternal === undefined
      ? current.account
      : current.users.find((a) => a.userId === userIdInternal);
  return assignment?.planId;
}

/**
 * Idempotent company setup: users, plans, user-plan assignments, and (after
 * an explicit confirmation) the account plan. Activation is the only
 * potentially disruptive step and is never done silently.
 */
export async function ensureSimcoWorld(api: ApiClient, prompter: Prompter): Promise<SimcoWorld> {
  const plans = expect(await fetchPlans(api), 200, 'list plans');
  const accountPlan = await ensurePlan(api, plans, SIMCO_ACCOUNT_PLAN);
  const basicPlan = await ensurePlan(api, plans, SIMCO_BASIC_PLAN);
  const plusPlan = await ensurePlan(api, plans, SIMCO_PLUS_PLAN);

  const users = expect(await fetchUsers(api), 200, 'list users');
  const userIds: string[] = [];
  for (const clientUserId of SIMCO_USERS) {
    if (users.some((u) => u.clientUserId === clientUserId)) {
      userIds.push(clientUserId);
      continue;
    }
    expect(await createUser(api, clientUserId), 201, `create user ${clientUserId}`);
    printChanged(`created user ${clientUserId}`);
    userIds.push(clientUserId);
  }

  const refreshedUsers = expect(await fetchUsers(api), 200, 'list users');
  const current = expect(await fetchCurrentAssignments(api), 200, 'read current assignments');
  const accountPlanAtStart =
    current.account === null ? null : { id: current.account.planId, name: current.account.planName };

  const desired: { clientUserId: string; planId: number; planName: string }[] = [
    { clientUserId: userIds[0], planId: basicPlan.id, planName: basicPlan.name },
    { clientUserId: userIds[1], planId: basicPlan.id, planName: basicPlan.name },
    { clientUserId: userIds[2], planId: plusPlan.id, planName: plusPlan.name },
  ];
  for (const want of desired) {
    const user = refreshedUsers.find((u) => u.clientUserId === want.clientUserId);
    if (user === undefined) continue;
    if (assignCurrent(current, user.id) === want.planId) continue;
    expect(
      await createAssignment(api, { userId: want.clientUserId, planId: want.planId }),
      201,
      `assign ${want.planName} to ${want.clientUserId}`
    );
    printChanged(`assigned ${want.planName} to ${want.clientUserId} (effective immediately)`);
  }

  if (current.account !== null && current.account.planId === accountPlan.id) {
    printOk(`account plan: ${accountPlan.name} (already active)`);
  } else {
    const currentLabel = current.account === null ? 'no account plan (requests fail with 409)' : current.account.planName;
    const activate = await prompter.yesNo(
      `Activate "${accountPlan.name}" (allowance ${accountPlan.monthlyAllowance}) for this account?` +
        `\n  Currently: ${currentLabel}. This replaces the account assignment; you can restore it before exit.`,
      current.account === null
    );
    if (activate) {
      expect(await createAssignment(api, { planId: accountPlan.id }), 201, 'activate SimCo account plan');
      printChanged(`activated ${accountPlan.name} (previous: ${currentLabel})`);
    } else {
      printNote('account plan left untouched — scenarios needing it will offer activation again');
    }
  }

  return { accountPlan, basicPlan, plusPlan, userIds, accountPlanAtStart };
}

/**
 * Activate the SimCo account plan mid-session (offered by scenarios that
 * require a mutable, small account allowance).
 */
export async function activateSimcoAccountPlan(
  api: ApiClient,
  accountPlanId: number
): Promise<void> {
  const current = expect(await fetchCurrentAssignments(api), 200, 'read current assignments');
  if (current.account !== null && current.account.planId === accountPlanId) return;
  expect(await createAssignment(api, { planId: accountPlanId }), 201, 'activate SimCo account plan');
  printChanged(`activated SimCo Account Plan (previous: ${current.account?.planName ?? 'none'})`);
}
