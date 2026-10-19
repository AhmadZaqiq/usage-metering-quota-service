import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, inArray } from 'drizzle-orm';
import { createApp } from '../app.js';
import { ApiClient } from '../cli/apiClient.js';
import { buildContext, type SimContext } from '../cli/simulate/context.js';
import type { MenuInput, Prompter } from '../cli/simulate/menu.js';
import {
  ensureSimcoWorld,
  SIMCO_ACCOUNT_PLAN,
  SIMCO_BASIC_PLAN,
  SIMCO_PLUS_PLAN,
  SIMCO_USERS,
  type SimcoWorld,
} from '../cli/simulate/setup.js';
import { ensureUserOnPlan, primeAllowance } from '../cli/simulate/scenarios/helpers.js';
import {
  fetchCurrentAssignments,
  fetchUsers,
  postUsage,
} from '../cli/simulate/api.js';
import { closeRateLimiterStore } from '../infrastructure/rateLimiter.js';
import { getTestDb } from './setup.js';
import { setupBasicTestContext, type TestContext } from './utils.js';
import { plans, planAssignments, users } from '../db/schema/index.js';

/**
 * Simulator paths against a real HTTP server and the real test database:
 * setup idempotency (never duplicate a user or plan) and the quota-prime
 * helpers (exact headroom, no duplicate assignment rows). All traffic goes
 * through the public API — the same surface the CLI itself uses.
 */

class FakePrompter implements Prompter {
  calls = 0;
  constructor(private readonly answer: boolean) {}
  async yesNo(): Promise<boolean> {
    this.calls += 1;
    return this.answer;
  }
}

function fakeMenu(): MenuInput {
  const unavailable = (method: string) => async (): Promise<never> => {
    throw new Error(`menu.${method} is not available in tests`);
  };
  return {
    yesNo: async () => true,
    text: unavailable('text'),
    choice: unavailable('choice'),
    positiveInt: unavailable('positiveInt'),
  };
}

describe('company simulator', () => {
  let server: Server;
  let baseUrl: string;
  let api: ApiClient;
  let context: TestContext;

  beforeEach(async () => {
    // Helpers print progress lines; assertions below are the signal.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Fresh rate-limit counters per test (store is process-wide).
    await closeRateLimiterStore();

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    context = await setupBasicTestContext();
    api = new ApiClient(baseUrl, context.apiKey.key);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      // fetch() keeps connections alive; without this, close() would wait.
      server.closeAllConnections();
    });
    vi.restoreAllMocks();
  });

  function makeContext(world: SimcoWorld): SimContext {
    return buildContext({
      api,
      menu: fakeMenu(),
      key: context.apiKey.key,
      baseUrl,
      world,
      runId: 'vitest',
    });
  }

  it('ensureSimcoWorld creates the company once and reuses it on the next run', async () => {
    const prompter = new FakePrompter(true);
    const first = await ensureSimcoWorld(api, prompter);
    const second = await ensureSimcoWorld(api, prompter);

    // First run activates after confirmation; second run finds it active.
    expect(prompter.calls).toBe(1);
    expect(second.accountPlan.id).toBe(first.accountPlan.id);
    expect(second.accountPlanAtStart?.id).toBe(second.accountPlan.id);
    expect(second.userIds).toEqual([...SIMCO_USERS]);
    expect(second.basicPlan.monthlyAllowance).toBe(SIMCO_BASIC_PLAN.allowance);
    expect(second.plusPlan.maxUnitsPerRequest).toBe(SIMCO_PLUS_PLAN.cap);

    // No duplicates at the database level — read-before-write, not name magic.
    const db = getTestDb();
    const planRows = await db
      .select({ name: plans.name })
      .from(plans)
      .where(
        inArray(plans.name, [
          SIMCO_ACCOUNT_PLAN.name,
          SIMCO_BASIC_PLAN.name,
          SIMCO_PLUS_PLAN.name,
        ])
      );
    expect(planRows).toHaveLength(3);

    const userRows = await db
      .select({ clientUserId: users.clientUserId })
      .from(users)
      .where(inArray(users.clientUserId, [...SIMCO_USERS]));
    expect(userRows).toHaveLength(3);

    // Assignments match the spec: ana/bob on Basic, cara on Plus, SimCo active.
    const current = (await fetchCurrentAssignments(api)).data;
    expect(current.account?.planId).toBe(second.accountPlan.id);
    const userIds = (await fetchUsers(api)).data;
    const planFor = (clientUserId: string): number | undefined => {
      const user = userIds.find((u) => u.clientUserId === clientUserId);
      return current.users.find((a) => a.userId === user?.id)?.planId;
    };
    expect(planFor('simco-ana')).toBe(second.basicPlan.id);
    expect(planFor('simco-bob')).toBe(second.basicPlan.id);
    expect(planFor('simco-cara')).toBe(second.plusPlan.id);
  });

  it('primeAllowance leaves exactly the requested headroom, repeatably', async () => {
    const world = await ensureSimcoWorld(api, new FakePrompter(true));
    const ctx = makeContext(world);

    const first = await primeAllowance(ctx, world.basicPlan, 'user', '100', 'simco-ana');
    const probe = await postUsage(api, {
      userId: 'simco-ana',
      units: '1',
      requestId: 'itest-prime-1',
    });
    expect(probe.status).toBe(200);
    expect(probe.data.decision).toBe('accepted');
    expect(probe.data.userRemaining).toBe('99');
    // Fresh database: the probe is ana's first usage, so usage must be exactly 1.
    expect(first.used).toBe('1');

    // Priming again from an arbitrary mid-period state must be equally exact.
    await primeAllowance(ctx, world.basicPlan, 'user', '100', 'simco-ana');
    const again = await postUsage(api, {
      userId: 'simco-ana',
      units: '1',
      requestId: 'itest-prime-2',
    });
    expect(again.status).toBe(200);
    expect(again.data.userRemaining).toBe('99');
  });

  it('ensureUserOnPlan is a no-op when already assigned and creates one row otherwise', async () => {
    const world = await ensureSimcoWorld(api, new FakePrompter(true));
    const ctx = makeContext(world);
    const db = getTestDb();

    const assignmentRowsForAna = async (): Promise<number> => {
      const rows = await db
        .select({ id: planAssignments.id })
        .from(planAssignments)
        .innerJoin(users, eq(planAssignments.userId, users.id))
        .where(eq(users.clientUserId, 'simco-ana'));
      return rows.length;
    };

    // Already on Basic after setup: both calls must skip.
    const onBasicFirst = await ensureUserOnPlan(ctx, 'simco-ana', world.basicPlan.id, world.basicPlan.name);
    const rowsAfterFirst = await assignmentRowsForAna();
    const onBasicAgain = await ensureUserOnPlan(ctx, 'simco-ana', world.basicPlan.id, world.basicPlan.name);
    expect(onBasicFirst).toBe(false);
    expect(onBasicAgain).toBe(false);
    expect(await assignmentRowsForAna()).toBe(rowsAfterFirst);

    // Switching plans creates exactly one historical row and takes effect now.
    const switched = await ensureUserOnPlan(ctx, 'simco-ana', world.plusPlan.id, world.plusPlan.name);
    expect(switched).toBe(true);
    expect(await assignmentRowsForAna()).toBe(rowsAfterFirst + 1);

    const current = (await fetchCurrentAssignments(api)).data;
    const userIds = (await fetchUsers(api)).data;
    const ana = userIds.find((u) => u.clientUserId === 'simco-ana');
    expect(current.users.find((a) => a.userId === ana?.id)?.planId).toBe(world.plusPlan.id);

    // And switching back to the current plan stays a no-op.
    const back = await ensureUserOnPlan(ctx, 'simco-ana', world.plusPlan.id, world.plusPlan.name);
    expect(back).toBe(false);
    expect(await assignmentRowsForAna()).toBe(rowsAfterFirst + 1);
  });
});
