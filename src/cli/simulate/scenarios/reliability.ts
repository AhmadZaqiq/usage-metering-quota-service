import { errCode } from '../../apiClient.js';
import { ScenarioReport } from '../../output.js';
import { fetchHistory, postUsage } from '../api.js';
import type { SimContext } from '../context.js';
import { expect } from '../guard.js';
import { printDecision, printError, printNote, printSection } from '../present.js';
import { ensureUserOnPlan, primeAllowance, requireSimcoUser } from './helpers.js';
import { loadSnapshot } from '../snapshot.js';

/** Reliability scenarios 9–11: idempotency, conflicts, and error contracts. */

const ANA = 'simco-ana';

export async function s9IdempotentRetry(ctx: SimContext): Promise<void> {
  printSection('Scenario 9: idempotent retry');
  console.log('  The same requestId + identical payload returns the original committed result.');
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

  const requestId = ctx.nextRequestId('s9');
  const first = await postUsage(ctx.api, { userId: ANA, units: '5', requestId });
  printDecision(first);
  const retry = await postUsage(ctx.api, { userId: ANA, units: '5', requestId });
  printDecision(retry);

  report.check('both attempts HTTP 200', first.status === 200 && retry.status === 200);
  report.check(
    'retry replays the original decision',
    retry.data.decision === first.data.decision,
    `first=${first.data.decision} retry=${String(retry.data.decision)}`
  );
  report.check(
    'retry returns the original remainings (no second debit)',
    retry.data.accountRemaining === first.data.accountRemaining &&
      retry.data.userRemaining === first.data.userRemaining,
    `account ${String(retry.data.accountRemaining)} vs ${String(first.data.accountRemaining)}`
  );

  const rows = expect(
    await fetchHistory(ctx.api, { userId: ANA, limit: 50 }),
    200,
    'read history'
  ).items.filter((i) => i.requestId === requestId);
  report.check('recorded exactly once in history', rows.length === 1, `found ${rows.length} rows`);
  report.summary();
}

export async function s10IdempotencyConflict(ctx: SimContext): Promise<void> {
  printSection('Scenario 10: idempotency key conflict');
  console.log('  Reusing a requestId with different units is a real 409 — the service refuses to guess.');
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

  const requestId = ctx.nextRequestId('s10');
  const first = await postUsage(ctx.api, { userId: ANA, units: '5', requestId });
  report.check('original request accepted', first.status === 200 && first.data.decision === 'accepted');

  const conflicting = await postUsage(ctx.api, { userId: ANA, units: '6', requestId });
  printError(conflicting.status, conflicting.data);
  report.check('same key, different payload → HTTP 409', conflicting.status === 409, `got ${conflicting.status}`);
  report.check(
    'error code is a conflict code',
    errCode(conflicting) === 'CONFLICT' || errCode(conflicting) === 'IDEMPOTENCY_CONFLICT',
    `got ${errCode(conflicting)}`
  );

  const rows = expect(
    await fetchHistory(ctx.api, { userId: ANA, limit: 50 }),
    200,
    'read history'
  ).items.filter((i) => i.requestId === requestId);
  report.check('conflict stored no second row', rows.length === 1, `found ${rows.length} rows`);
  const latest = expect(await fetchHistory(ctx.api, { limit: 1 }), 200, 'read latest row').items[0];
  report.check(
    'conflict consumed no quota',
    latest !== undefined && latest.accountRemaining === first.data.accountRemaining,
    `account ${String(latest?.accountRemaining)} vs ${String(first.data.accountRemaining)}`
  );
  report.summary();
}

export async function s11ValidationAndAuthErrors(ctx: SimContext): Promise<void> {
  printSection('Scenario 11: validation and authentication errors');
  console.log('  Bad input and bad credentials fail closed, with consistent error codes and no secrets in output.');
  const report = new ScenarioReport();

  const invalid = await postUsage(ctx.api, { units: '0', requestId: ctx.nextRequestId('s11a') });
  printError(invalid.status, invalid.data);
  report.check('units=0 → HTTP 400', invalid.status === 400, `got ${invalid.status}`);
  report.check('code = VALIDATION_ERROR', errCode(invalid) === 'VALIDATION_ERROR', `got ${errCode(invalid)}`);

  const noAuth = await postUsage(
    ctx.api,
    { units: '1', requestId: ctx.nextRequestId('s11b') },
    { auth: false }
  );
  printError(noAuth.status, noAuth.data);
  report.check('missing credentials → HTTP 401', noAuth.status === 401, `got ${noAuth.status}`);
  report.check('code = AUTHENTICATION_FAILED', errCode(noAuth) === 'AUTHENTICATION_FAILED', `got ${errCode(noAuth)}`);

  const wrongKey = `${ctx.keyPrefix}.${'0'.repeat(64)}`;
  const wrongAuth = await postUsage(
    ctx.api,
    { units: '1', requestId: ctx.nextRequestId('s11c') },
    { keyOverride: wrongKey }
  );
  printError(wrongAuth.status, wrongAuth.data);
  report.check('wrong secret → HTTP 401', wrongAuth.status === 401, `got ${wrongAuth.status}`);

  report.check('displayed key is always masked', ctx.maskedKey === `${ctx.keyPrefix}.***`, ctx.maskedKey);
  printNote('the real key never reaches this output — only the public prefix is shown');
  report.summary();
}
