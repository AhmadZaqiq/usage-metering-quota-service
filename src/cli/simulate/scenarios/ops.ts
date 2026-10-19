import { ScenarioReport } from '../../output.js';
import { fetchHistory, postUsage } from '../api.js';
import type { SimContext } from '../context.js';
import { expect } from '../guard.js';
import { printHistoryPage, printNote, printSection } from '../present.js';
import { ensureUserOnPlan, primeAllowance, requireSimcoUser } from './helpers.js';
import { loadSnapshot } from '../snapshot.js';

/** Scenario 12: auditable history with honest pagination. */

const PAGE_SIZE = 3;
const ANA = 'simco-ana';

export async function s12HistoryPagination(ctx: SimContext): Promise<void> {
  printSection('Scenario 12: usage history and pagination');
  console.log('  Page through the decision log: accepted and rejected rows are both kept for audit.');
  console.log('  The API has no month filter — page/limit is the supported way to walk a period.');
  const report = new ScenarioReport();

  // Populate deterministic recent rows: accepted requests plus one rejection.
  const snap = await loadSnapshot(ctx.api);
  const ana = requireSimcoUser(snap, ANA);
  if (ana.plan === null) {
    report.check('ana has a user plan', false);
    report.summary();
    return;
  }
  await ensureUserOnPlan(ctx, ANA, ana.plan.id, ana.plan.name);
  await primeAllowance(ctx, ana.plan, 'user', '50', ANA);
  for (let i = 0; i < 4; i++) {
    const res = await postUsage(ctx.api, { userId: ANA, units: '1', requestId: ctx.nextRequestId('s12a') });
    if (res.status !== 200 || res.data.decision !== 'accepted') {
      report.check('populate accepted rows', false, `status=${res.status} decision=${String(res.data.decision)}`);
      report.summary();
      return;
    }
  }
  const overCap = (BigInt(ana.plan.maxUnitsPerRequest) + 1n).toString();
  const rejected = await postUsage(ctx.api, { userId: ANA, units: overCap, requestId: ctx.nextRequestId('s12b') });
  report.check('one rejected row recorded for the audit demo', rejected.status === 200 && rejected.data.decision === 'rejected');

  const page1 = expect(await fetchHistory(ctx.api, { page: 1, limit: PAGE_SIZE }), 200, 'read history page 1');
  printHistoryPage(page1);
  report.check(`page 1 is full (${PAGE_SIZE} rows)`, page1.items.length === PAGE_SIZE, `got ${page1.items.length}`);
  report.check('totalPages spans multiple pages', page1.totalPages >= 2, `got ${page1.totalPages}`);

  const page2 = expect(await fetchHistory(ctx.api, { page: 2, limit: PAGE_SIZE }), 200, 'read history page 2');
  printHistoryPage(page2);
  report.check('page 2 returns the remainder', page2.items.length >= 1 && page2.items.length <= PAGE_SIZE, `got ${page2.items.length}`);

  const rejectedSeen = [...page1.items, ...page2.items].filter((i) => i.decision === 'rejected');
  report.check('rejected requests are preserved in history', rejectedSeen.length >= 1, `found ${rejectedSeen.length}`);
  printNote('no month filter exists by design: walk pages (or filter by userId) to audit a period');
  report.summary();
}
