import { ApiClient, DemoError, maskKey } from '../apiClient.js';
import type { Options } from '../options.js';
import { runMenu } from '../simulate/actions.js';
import { createAssignment, fetchCurrentAssignments, healthReady } from '../simulate/api.js';
import { buildContext, type SimContext } from '../simulate/context.js';
import { expect } from '../simulate/guard.js';
import { EofError, Menu } from '../simulate/menu.js';
import { printChanged, printError, printNote, printOk, printSection } from '../simulate/present.js';
import { ensureSimcoWorld } from '../simulate/setup.js';

/**
 * `simulate` command: one fictional company driven entirely over HTTP through
 * the shared ApiClient. Setup is idempotent, the account-plan activation is
 * confirmed, and a normal exit offers to restore the previous account plan.
 */
export async function runSimulate(opts: Options, key: string): Promise<number> {
  const api = new ApiClient(opts.baseUrl, key);
  const menu = new Menu();
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  printSection('Company simulator');
  console.log(`  Target: ${opts.baseUrl}  Key: ${maskKey(key)}`);

  let ctx: SimContext | undefined;
  try {
    const ready = await healthReady(api);
    if (ready.status !== 200) {
      printError(ready.status, ready.data);
      console.error('Service is not ready — start it and retry (docker compose up app).');
      return 1;
    }
    printOk('service ready');

    const world = await ensureSimcoWorld(api, menu);
    ctx = buildContext({ api, menu, key, baseUrl: opts.baseUrl, world, runId });
    await runMenu(ctx);
    await offerRestore(ctx);
    printOk(`${ctx.companyName} session ended`);
    return 0;
  } catch (err) {
    if (err instanceof EofError) {
      console.log('\n  stdin closed — ending session.');
      if (
        ctx !== undefined &&
        ctx.world.accountPlanAtStart !== null &&
        ctx.world.accountPlanAtStart.id !== ctx.world.accountPlan.id
      ) {
        printNote('exit-time restore was skipped — switch back via menu 7 if SimCo is still active');
      }
      return 0;
    }
    if (err instanceof DemoError) {
      console.error(`\nSimulator failed: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    menu.close();
  }
}

/** One restore prompt after a normal exit, only when this session activated the SimCo plan. */
async function offerRestore(ctx: SimContext): Promise<void> {
  const start = ctx.world.accountPlanAtStart;
  if (start === null || start.id === ctx.world.accountPlan.id) return;
  try {
    const current = expect(await fetchCurrentAssignments(ctx.api), 200, 'read current assignments');
    if (current.account === null || current.account.planId !== ctx.world.accountPlan.id) return;
    const go = await ctx.menu.yesNo(
      `Restore account plan to "${start.name}"? (this session activated ${ctx.world.accountPlan.name})`,
      false
    );
    if (!go) return;
    expect(await createAssignment(ctx.api, { planId: start.id }), 201, 'restore account plan');
    printChanged(`account plan restored to ${start.name}`);
  } catch (err) {
    if (err instanceof EofError) throw err;
    printNote(`account-plan restore not completed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
