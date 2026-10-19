import { ScenarioReport } from '../../output.js';
import { patchPlan, postUsage } from '../api.js';
import type { SimContext } from '../context.js';
import { expect } from '../guard.js';
import { printChanged, printDecision, printNote, printSection } from '../present.js';
import {
  ensureSimcoAccountPlan,
  ensureUserOnPlan,
  primeAllowance,
  requireSimcoUser,
  restoreAllowance,
} from './helpers.js';
import { loadSnapshot } from '../snapshot.js';

/** Quota-behavior scenarios 1–8. Each announces the persistent changes it makes. */

const ANA = 'simco-ana';
const CARA = 'simco-cara';

export async function s1SuccessfulConsumption(ctx: SimContext): Promise<void> {
  printSection('Scenario 1: successful consumption');
  console.log('  A normal user-scoped request is accepted and debits both quotas.');
  const report = new ScenarioReport();
  const snap = await loadSnapshot(ctx.api);
  const ana = requireSimcoUser(snap, ANA);
  if (ana.plan === null) {
    report.check('ana has a user plan', false, 'assign one via menu 6');
    report.summary();
    return;
  }
  await ensureUserOnPlan(ctx, ANA, ana.plan.id, ana.plan.name);
  await primeAllowance(ctx, ana.plan, 'user', '100', ANA);

  const res = await postUsage(ctx.api, { userId: ANA, units: '5', requestId: ctx.nextRequestId('s1') });
  printDecision(res);
  report.check('HTTP 200', res.status === 200, `got ${res.status}`);
  report.check('decision = accepted', res.data.decision === 'accepted');
  report.check('userRemaining = 95 (headroom 100 − 5)', res.data.userRemaining === '95', `got ${String(res.data.userRemaining)}`);
  report.check('periodStart is a UTC month', /^\d{4}-\d{2}-\d{2}$/.test(res.data.periodStart), `got ${res.data.periodStart}`);
  report.summary();
}

export async function s2UserQuotaExceeded(ctx: SimContext): Promise<void> {
  printSection('Scenario 2: user quota exceeded');
  console.log('  Exhaust the user allowance with an accepted request, then watch the next one reject.');
  const report = new ScenarioReport();
  const snap = await loadSnapshot(ctx.api);
  const ana = requireSimcoUser(snap, ANA);
  if (ana.plan === null) {
    report.check('ana has a user plan', false);
    report.summary();
    return;
  }
  await ensureUserOnPlan(ctx, ANA, ana.plan.id, ana.plan.name);
  await primeAllowance(ctx, ana.plan, 'user', '10', ANA);

  const accepted = await postUsage(ctx.api, { userId: ANA, units: '10', requestId: ctx.nextRequestId('s2a') });
  printDecision(accepted);
  report.check('10 units accepted, userRemaining = 0', accepted.status === 200 && accepted.data.userRemaining === '0', `status=${accepted.status} userRemaining=${String(accepted.data.userRemaining)}`);

  const rejected = await postUsage(ctx.api, { userId: ANA, units: '1', requestId: ctx.nextRequestId('s2b') });
  printDecision(rejected);
  report.check('next request is a business rejection (HTTP 200)', rejected.status === 200 && rejected.data.decision === 'rejected');
  report.check('reason = user_quota_exceeded', rejected.data.rejectionReason === 'user_quota_exceeded', `got ${String(rejected.data.rejectionReason)}`);
  report.check('userRemaining stays clamped at 0', rejected.data.userRemaining === '0', `got ${String(rejected.data.userRemaining)}`);
  report.check(
    'rejected request consumed no account quota',
    rejected.data.accountRemaining === accepted.data.accountRemaining,
    `account ${String(rejected.data.accountRemaining)} vs ${String(accepted.data.accountRemaining)}`
  );

  await restoreAllowance(ctx, ana.plan.id, ana.plan.monthlyAllowance, ana.plan.name);
  report.summary();
}

export async function s3AccountQuotaExceeded(ctx: SimContext): Promise<void> {
  printSection('Scenario 3: account quota exceeded');
  console.log('  Set the account allowance exactly to current usage → remaining 0 → everything rejects.');
  const report = new ScenarioReport();

  await ensureSimcoAccountPlan(ctx);

  const snap = await loadSnapshot(ctx.api);
  const accountPlan = snap.accountPlan;
  if (accountPlan === null || accountPlan.id !== ctx.world.accountPlan.id) {
    report.check('SimCo account plan is active', false, `current: ${String(snap.current?.planName ?? 'none')}`);
    report.summary();
    return;
  }
  await primeAllowance(ctx, accountPlan, 'account', '0');

  const res = await postUsage(ctx.api, { units: '1', requestId: ctx.nextRequestId('s3') });
  printDecision(res);
  report.check('HTTP 200', res.status === 200, `got ${res.status}`);
  report.check('decision = rejected', res.data.decision === 'rejected');
  report.check('reason = account_quota_exceeded', res.data.rejectionReason === 'account_quota_exceeded', `got ${String(res.data.rejectionReason)}`);
  report.check('accountRemaining = 0 (clamped, never negative)', res.data.accountRemaining === '0', `got ${res.data.accountRemaining}`);

  await restoreAllowance(ctx, accountPlan.id, ctx.world.accountPlan.monthlyAllowance, accountPlan.name);
  report.summary();
}

export async function s4MaxUnitsPerRequest(ctx: SimContext): Promise<void> {
  printSection('Scenario 4: max units per request');
  console.log('  Quota is available, but a single request above the plan cap rejects on the cap alone.');
  const report = new ScenarioReport();
  const snap = await loadSnapshot(ctx.api);
  const ana = requireSimcoUser(snap, ANA);
  if (ana.plan === null) {
    report.check('ana has a user plan', false);
    report.summary();
    return;
  }
  await ensureUserOnPlan(ctx, ANA, ana.plan.id, ana.plan.name);
  await primeAllowance(ctx, ana.plan, 'user', '100', ANA);
  const cap = ana.plan.maxUnitsPerRequest;
  const overCap = (BigInt(cap) + 1n).toString();

  const atCap = await postUsage(ctx.api, { userId: ANA, units: cap, requestId: ctx.nextRequestId('s4a') });
  printDecision(atCap);
  report.check(`units = cap (${cap}) accepted`, atCap.status === 200 && atCap.data.decision === 'accepted');

  const over = await postUsage(ctx.api, { userId: ANA, units: overCap, requestId: ctx.nextRequestId('s4b') });
  printDecision(over);
  report.check(`units = cap+1 (${overCap}) rejected`, over.status === 200 && over.data.decision === 'rejected');
  report.check('reason = max_per_request_exceeded', over.data.rejectionReason === 'max_per_request_exceeded', `got ${String(over.data.rejectionReason)}`);
  report.check('limitScope = user (user cap binds before account cap)', over.data.limitScope === 'user', `got ${String(over.data.limitScope)}`);
  // Baseline = the accepted request's response: the rejection itself must leave
  // the account exactly where the last accepted request left it.
  report.check(
    'no quota consumed by the rejection',
    atCap.status === 200 && over.data.accountRemaining === atCap.data.accountRemaining,
    `account ${String(over.data.accountRemaining)} vs ${String(atCap.data.accountRemaining)}`
  );
  report.summary();
}

export async function s5SharedAccountUsage(ctx: SimContext): Promise<void> {
  printSection('Scenario 5: shared account usage');
  console.log('  Two different users debit the same account pool; accountRemaining falls across both.');
  const report = new ScenarioReport();

  await ensureSimcoAccountPlan(ctx);

  const snap = await loadSnapshot(ctx.api);
  const accountPlan = snap.accountPlan;
  const ana = requireSimcoUser(snap, ANA);
  const cara = requireSimcoUser(snap, CARA);
  if (accountPlan === null || ana.plan === null || cara.plan === null) {
    report.check('account plan and user plans are assigned', false);
    report.summary();
    return;
  }
  await ensureUserOnPlan(ctx, ANA, ana.plan.id, ana.plan.name);
  await ensureUserOnPlan(ctx, CARA, cara.plan.id, cara.plan.name);
  // User primes first: each one re-primes the account pool as a side effect,
  // so the exact account headroom has to be set last to stay exact.
  await primeAllowance(ctx, ana.plan, 'user', '100', ANA);
  await primeAllowance(ctx, cara.plan, 'user', '500', CARA);
  await primeAllowance(ctx, accountPlan, 'account', '100');

  const first = await postUsage(ctx.api, { userId: ANA, units: '7', requestId: ctx.nextRequestId('s5a') });
  printDecision(first);
  report.check('ana 7 units accepted', first.status === 200 && first.data.decision === 'accepted');
  report.check('accountRemaining = 93 (100 − 7)', first.data.accountRemaining === '93', `got ${String(first.data.accountRemaining)}`);

  const second = await postUsage(ctx.api, { userId: CARA, units: '3', requestId: ctx.nextRequestId('s5b') });
  printDecision(second);
  report.check('cara 3 units accepted', second.status === 200 && second.data.decision === 'accepted');
  report.check('accountRemaining = 90 (93 − 3): one shared pool', second.data.accountRemaining === '90', `got ${String(second.data.accountRemaining)}`);
  report.check('user remainings are per-user, not shared', second.data.userRemaining !== first.data.userRemaining, `ana=${String(first.data.userRemaining)} cara=${String(second.data.userRemaining)}`);

  await restoreAllowance(ctx, accountPlan.id, ctx.world.accountPlan.monthlyAllowance, accountPlan.name);
  report.summary();
}

export async function s6DifferentUserPlans(ctx: SimContext): Promise<void> {
  printSection('Scenario 6: different user plans');
  console.log('  The same units hit two plans with different allowances → different remainings.');
  const report = new ScenarioReport();
  const snap = await loadSnapshot(ctx.api);
  const ana = requireSimcoUser(snap, ANA);
  const cara = requireSimcoUser(snap, CARA);
  if (ana.plan === null || cara.plan === null) {
    report.check('ana and cara have user plans', false);
    report.summary();
    return;
  }
  await ensureUserOnPlan(ctx, ANA, ana.plan.id, ana.plan.name);
  await ensureUserOnPlan(ctx, CARA, cara.plan.id, cara.plan.name);
  await primeAllowance(ctx, ana.plan, 'user', '100', ANA);
  await primeAllowance(ctx, cara.plan, 'user', '1000', CARA);

  const anaRes = await postUsage(ctx.api, { userId: ANA, units: '10', requestId: ctx.nextRequestId('s6a') });
  printDecision(anaRes);
  const caraRes = await postUsage(ctx.api, { userId: CARA, units: '10', requestId: ctx.nextRequestId('s6b') });
  printDecision(caraRes);

  report.check('both accepted', anaRes.status === 200 && caraRes.status === 200 && anaRes.data.decision === 'accepted' && caraRes.data.decision === 'accepted');
  report.check(`ana on ${ana.plan.name}: userRemaining = 90`, anaRes.data.userRemaining === '90', `got ${String(anaRes.data.userRemaining)}`);
  report.check(`cara on ${cara.plan.name}: userRemaining = 990`, caraRes.data.userRemaining === '990', `got ${String(caraRes.data.userRemaining)}`);
  report.check('same units, different plans → different remainings', anaRes.data.userRemaining !== caraRes.data.userRemaining);
  report.summary();
}

export async function s7PlanChangeImmediate(ctx: SimContext): Promise<void> {
  printSection('Scenario 7: plan change takes effect immediately');
  console.log('  Switch ana from SimCo Basic to SimCo Plus; the very next request uses the new allowance.');
  const report = new ScenarioReport();
  const snap = await loadSnapshot(ctx.api);
  const ana = requireSimcoUser(snap, ANA);
  const basic = ctx.world.basicPlan;
  const plus = ctx.world.plusPlan;
  if (ana.plan === null) {
    report.check('ana has a user plan', false);
    report.summary();
    return;
  }
  await ensureUserOnPlan(ctx, ANA, basic.id, basic.name);
  const { used } = await primeAllowance(ctx, basic, 'user', '100', ANA);

  const before = await postUsage(ctx.api, { userId: ANA, units: '5', requestId: ctx.nextRequestId('s7a') });
  printDecision(before);
  report.check(
    `on ${basic.name}: accepted, userRemaining = 95`,
    before.status === 200 && before.data.userRemaining === '95',
    `got ${String(before.data.userRemaining)}`
  );

  // ana's usage is now exact: size the Plus plan so the same request leaves 995.
  const anaUsage = BigInt(used) + 5n;
  const sizedPlus = expect(
    await patchPlan(ctx.api, plus.id, { monthlyAllowance: (anaUsage + 1000n).toString() }),
    200,
    `size ${plus.name}`
  );
  printChanged(`${plus.name}: allowance set to ${sizedPlus.monthlyAllowance} so the switch is deterministic`);

  await ensureUserOnPlan(ctx, ANA, plus.id, plus.name);
  const after = await postUsage(ctx.api, { userId: ANA, units: '5', requestId: ctx.nextRequestId('s7b') });
  printDecision(after);
  report.check(
    `on ${plus.name}: accepted, userRemaining = 995`,
    after.status === 200 && after.data.userRemaining === '995',
    `got ${String(after.data.userRemaining)}`
  );
  report.check(
    'counters were not reset — usage carried into the new plan',
    BigInt(String(after.data.userRemaining)) < BigInt(sizedPlus.monthlyAllowance)
  );
  printNote(`ana stays on ${plus.name}; the next simulator start re-applies SimCo assignments`);
  report.summary();
}

export async function s8AllowanceBelowUsage(ctx: SimContext): Promise<void> {
  printSection('Scenario 8: allowance reduced below usage');
  console.log('  Lower the plan allowance under what was already consumed → remaining clamps to 0.');
  const report = new ScenarioReport();
  const snap = await loadSnapshot(ctx.api);
  const ana = requireSimcoUser(snap, ANA);
  if (ana.plan === null) {
    report.check('ana has a user plan', false);
    report.summary();
    return;
  }
  await ensureUserOnPlan(ctx, ANA, ana.plan.id, ana.plan.name);
  const { used } = await primeAllowance(ctx, ana.plan, 'user', '100', ANA);

  const consumed = await postUsage(ctx.api, { userId: ANA, units: '10', requestId: ctx.nextRequestId('s8a') });
  printDecision(consumed);
  report.check('consumed 10 units first', consumed.status === 200 && consumed.data.decision === 'accepted');

  const newAllowance = used; // usage after the probe — 10 less than current usage
  expect(
    await patchPlan(ctx.api, ana.plan.id, { monthlyAllowance: newAllowance }),
    200,
    `lower ${ana.plan.name}`
  );
  printChanged(`lowered ${ana.plan.name} allowance to ${newAllowance} (below current usage → clamped remaining 0)`);

  const rejected = await postUsage(ctx.api, { userId: ANA, units: '1', requestId: ctx.nextRequestId('s8b') });
  printDecision(rejected);
  report.check('next request rejected with HTTP 200', rejected.status === 200 && rejected.data.decision === 'rejected');
  report.check('reason = user_quota_exceeded', rejected.data.rejectionReason === 'user_quota_exceeded', `got ${String(rejected.data.rejectionReason)}`);
  report.check('userRemaining clamped at 0, not negative', rejected.data.userRemaining === '0', `got ${String(rejected.data.userRemaining)}`);

  await restoreAllowance(ctx, ana.plan.id, ana.plan.monthlyAllowance, ana.plan.name);
  report.summary();
}
