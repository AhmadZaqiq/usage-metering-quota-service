import { ApiClient, DemoError, maskKey, errCode } from '../apiClient.js';
import { ScenarioReport } from '../output.js';
import type { Options } from '../options.js';
import { healthGate, ensureDemoPlansAndUsers, probeUsed } from './setup.js';

const ACCOUNT_HEADROOM = 40n;

export async function runDemo(opts: Options, key: string): Promise<number> {
  const report: ScenarioReport = new ScenarioReport();
  const api = new ApiClient(opts.baseUrl, key);
  const runId = Date.now().toString(36);
  console.log(`\n=== Usage Metering demo (run ${runId}) ===`);
  console.log(`Target: ${opts.baseUrl}  Key: ${maskKey(key)}\n`);

  try {
    await healthGate(api, report);

    const setup = await ensureDemoPlansAndUsers(api, report, runId);
    const used = await probeUsed(api, report, runId);
    report.expect('established baseline usage', true, `used=${used}`);

    // Known account remaining for every following assertion.
    const headroomPatch = await api.request('PATCH', `/plans/${setup.accountPlanId}`, {
      monthlyAllowance: (used + ACCOUNT_HEADROOM).toString(),
    });
    report.expect(
      'set account headroom to 40',
      headroomPatch.status === 200,
      `got ${headroomPatch.status}`
    );

    const usageBody = (userId: string, units: string, requestId: string) => ({
      userId,
      units,
      requestId,
    });
    const s1Key = `demo-s1-${runId}`;

    // S1: accepted user-scoped request.
    const s1 = await api.request('POST', '/usage', usageBody(setup.userIds[0], '5', s1Key));
    report.expect('S1 accepted usage returns 200', s1.status === 200, `got ${s1.status}`);
    report.expect('S1 decision accepted', s1.data.decision === 'accepted');
    report.expect(
      'S1 accountRemaining = 40 - 5',
      s1.data.accountRemaining === '35',
      `got ${String(s1.data.accountRemaining)}`
    );
    report.expect(
      'S1 userRemaining = 100 - 5',
      s1.data.userRemaining === '95',
      `got ${String(s1.data.userRemaining)}`
    );

    // S1b: demo-3 is on the Plus plan (allowance 200), so the same 5 units
    // leave a larger userRemaining than demo-1's plan did (95) - proves the
    // userRemaining is plan-scoped, not a constant.
    const s1b = await api.request('POST', '/usage', usageBody(setup.userIds[2], '5', `demo-s1b-${runId}`));
    report.expect('S1b accepted usage returns 200', s1b.status === 200, `got ${s1b.status}`);
    report.expect('S1b decision accepted', s1b.data.decision === 'accepted');
    report.expect(
      'S1b userRemaining = 200 - 5 (Plus plan)',
      s1b.data.userRemaining === '195',
      `got ${String(s1b.data.userRemaining)}`
    );
    report.expect(
      'S1b accountRemaining = 35 - 5',
      s1b.data.accountRemaining === '30',
      `got ${String(s1b.data.accountRemaining)}`
    );

    // S2: reduce the small user plan below usage -> zero remaining -> rejection.
    // The Plus plan is untouched, so demo-3's decision must diverge from demo-2's.
    const lowerUser = await api.request('PATCH', `/plans/${setup.userPlanId}`, {
      monthlyAllowance: '5',
    });
    report.expect(
      'S2 lowered user allowance to 5',
      lowerUser.status === 200,
      `got ${lowerUser.status}`
    );

    const s2a = await api.request(
      'POST',
      '/usage',
      usageBody(setup.userIds[1], '5', `demo-s2a-${runId}`)
    );
    report.expect(
      'S2a user consumes full allowance',
      s2a.data.decision === 'accepted',
      `got ${String(s2a.data.decision)}`
    );
    report.expect(
      'S2a userRemaining = 0',
      s2a.data.userRemaining === '0',
      `got ${String(s2a.data.userRemaining)}`
    );
    report.expect(
      'S2a accountRemaining = 25',
      s2a.data.accountRemaining === '25',
      `got ${String(s2a.data.accountRemaining)}`
    );

    const s2b = await api.request(
      'POST',
      '/usage',
      usageBody(setup.userIds[1], '1', `demo-s2b-${runId}`)
    );
    report.expect(
      'S2b rejected with 200 (business rejection)',
      s2b.status === 200 && s2b.data.decision === 'rejected'
    );
    report.expect(
      'S2b rejectionReason = user_quota_exceeded',
      s2b.data.rejectionReason === 'user_quota_exceeded',
      `got ${String(s2b.data.rejectionReason)}`
    );
    report.expect(
      'S2b userRemaining clamped at 0',
      s2b.data.userRemaining === '0',
      `got ${String(s2b.data.userRemaining)}`
    );
    report.expect(
      'S2b consumed no account quota',
      s2b.data.accountRemaining === '25',
      `got ${String(s2b.data.accountRemaining)}`
    );

    // S2c: same 5 units that just rejected demo-2 (small plan, 0 left) are
    // still accepted for demo-3 (Plus plan, 190 left) - a plan-dependent decision.
    const s2c = await api.request('POST', '/usage', usageBody(setup.userIds[2], '5', `demo-s2c-${runId}`));
    report.expect(
      'S2c Plus-plan user accepts the same units the small plan rejected',
      s2c.status === 200 && s2c.data.decision === 'accepted',
      `status=${s2c.status} decision=${String(s2c.data.decision)}`
    );
    report.expect(
      'S2c userRemaining = 195 - 5 (Plus plan)',
      s2c.data.userRemaining === '190',
      `got ${String(s2c.data.userRemaining)}`
    );
    report.expect(
      'S2c accountRemaining = 25 - 5',
      s2c.data.accountRemaining === '20',
      `got ${String(s2c.data.accountRemaining)}`
    );

    // S3: per-request limit rejection. demo-1 is on the small plan (cap 10
    // units/request) and has plenty of remaining allowance, so 11 units is
    // rejected on the per-request cap alone.
    const s3 = await api.request(
      'POST',
      '/usage',
      usageBody(setup.userIds[0], '11', `demo-s3-${runId}`)
    );
    report.expect(
      'S3 over-max units rejected with max_per_request_exceeded',
      s3.status === 200 && s3.data.rejectionReason === 'max_per_request_exceeded',
      `status=${s3.status} reason=${String(s3.data.rejectionReason)}`
    );
    report.expect(
      'S3 limitScope = user (user-plan cap is the binding limit)',
      s3.data.limitScope === 'user',
      `got ${String(s3.data.limitScope)}`
    );

    // S4: reduce account allowance below usage -> zero remaining -> rejection.
    const usedAfterS2 = used + 20n; // S1: 5, S1b: 5, S2a: 5, S2c: 5 (S2b/S3 rejected, no debit)
    const lowerAccount = await api.request('PATCH', `/plans/${setup.accountPlanId}`, {
      monthlyAllowance: (usedAfterS2 - 1n).toString(),
    });
    report.expect(
      'S4 lowered account allowance below usage',
      lowerAccount.status === 200,
      `got ${lowerAccount.status}`
    );

    const s4 = await api.request(
      'POST',
      '/usage',
      usageBody(setup.userIds[0], '1', `demo-s4-${runId}`)
    );
    report.expect('S4 rejected with 200', s4.status === 200 && s4.data.decision === 'rejected');
    report.expect(
      'S4 rejectionReason = account_quota_exceeded',
      s4.data.rejectionReason === 'account_quota_exceeded',
      `got ${String(s4.data.rejectionReason)}`
    );
    report.expect(
      'S4 accountRemaining clamped at 0',
      s4.data.accountRemaining === '0',
      `got ${String(s4.data.accountRemaining)}`
    );

    // S5: raising the allowance takes effect on the very next request.
    const restoreUser = await api.request('PATCH', `/plans/${setup.userPlanId}`, {
      monthlyAllowance: '100',
    });
    report.expect(
      'S5 restored user allowance',
      restoreUser.status === 200,
      `got ${restoreUser.status}`
    );
    const raiseAccount = await api.request('PATCH', `/plans/${setup.accountPlanId}`, {
      monthlyAllowance: (usedAfterS2 + 50n).toString(),
    });
    report.expect(
      'S5 raised account allowance',
      raiseAccount.status === 200,
      `got ${raiseAccount.status}`
    );

    const s5 = await api.request(
      'POST',
      '/usage',
      usageBody(setup.userIds[0], '1', `demo-s5-${runId}`)
    );
    report.expect(
      'S5 next request accepted after raise (immediate plan change)',
      s5.status === 200 && s5.data.decision === 'accepted',
      `got ${String(s5.data.decision)}`
    );
    report.expect(
      'S5 accountRemaining = 49',
      s5.data.accountRemaining === '49',
      `got ${String(s5.data.accountRemaining)}`
    );
    report.expect(
      'S5 userRemaining = 94',
      s5.data.userRemaining === '94',
      `got ${String(s5.data.userRemaining)}`
    );

    // S6: idempotent replay returns the original committed result.
    const s6 = await api.request('POST', '/usage', usageBody(setup.userIds[0], '5', s1Key));
    report.expect(
      'S6 replay decision matches original',
      s6.data.decision === s1.data.decision &&
        s6.data.accountRemaining === s1.data.accountRemaining,
      `replay accountRemaining=${String(s6.data.accountRemaining)} vs original=${String(s1.data.accountRemaining)}`
    );
    const s6b = await api.request(
      'POST',
      '/usage',
      usageBody(setup.userIds[1], '1', `demo-s2b-${runId}`)
    );
    report.expect(
      'S6 replay of a rejection keeps the cached decision',
      s6b.data.decision === 'rejected' && s6b.data.rejectionReason === 'user_quota_exceeded',
      `got ${String(s6b.data.rejectionReason)}`
    );

    // S7: credential and input rejections.
    const noAuth = await api.request(
      'POST',
      '/usage',
      { units: '1', requestId: `demo-s7a-${runId}` },
      { auth: false }
    );
    report.expect('S7 missing credentials -> 401', noAuth.status === 401, `got ${noAuth.status}`);
    const wrongKey = await api.request(
      'POST',
      '/usage',
      { units: '1', requestId: `demo-s7b-${runId}` },
      { keyOverride: `${key.split('.')[0]}.${'0'.repeat(64)}` }
    );
    report.expect('S7 wrong secret -> 401', wrongKey.status === 401, `got ${wrongKey.status}`);
    const zeroUnits = await api.request('POST', '/usage', {
      userId: setup.userIds[0],
      units: '0',
      requestId: `demo-s7c-${runId}`,
    });
    report.expect(
      'S7 invalid units -> 400 VALIDATION_ERROR',
      zeroUnits.status === 400 && errCode(zeroUnits) === 'VALIDATION_ERROR',
      `status=${zeroUnits.status} code=${errCode(zeroUnits)}`
    );

    // S8: history and current assignments reflect the demo.
    const usersRes = await api.request('GET', '/users');
    const users = usersRes.data as unknown as { id: number; clientUserId: string }[];
    const ourIds = users.filter((u) => setup.userIds.includes(u.clientUserId)).map((u) => u.id);
    report.expect('S8 all three demo users exist', ourIds.length === 3, `found ${ourIds.length}/3`);

    const current = await api.request('GET', '/assignments/current');
    const currentData = current.data as unknown as {
      account: { isCurrent: boolean } | null;
      users: { userId: number | null }[];
    };
    const currentUsers = new Set(currentData.users.map((u) => u.userId));
    report.expect(
      'S8 all three demo users have a current user plan',
      ourIds.every((id) => currentUsers.has(id))
    );
    report.expect(
      'S8 an account plan is in effect right now',
      currentData.account !== null && currentData.account.isCurrent === true
    );

    const history = await api.request('GET', '/usage?limit=50');
    report.expect('S8 history readable', history.status === 200, `got ${history.status}`);
    const items = history.data.items as {
      requestId: string;
      decision: string;
      units: string;
    }[];
    const demoPrefix = `demo-`;
    const demoItems = items.filter((i) => i.requestId.startsWith(demoPrefix));
    const acceptedCount = demoItems.filter((i) => i.decision === 'accepted').length;
    const rejectedCount = demoItems.filter((i) => i.decision === 'rejected').length;
    // A rejected request must be recorded in history with its decision, not
    // silently dropped - auditability of rejections is part of the contract.
    const s2bKey = `demo-s2b-${runId}`;
    const s2bRow = demoItems.find((i) => i.requestId === s2bKey);
    report.expect(
      'S8 rejected request is preserved in history with decision=rejected',
      s2bRow !== undefined && s2bRow.decision === 'rejected',
      s2bRow ? `got decision=${s2bRow.decision}` : `no row with key ${s2bKey}`
    );
    console.log(
      `  History (page 1): total=${String(history.data.total)} demo rows=${demoItems.length}` +
        ` (accepted=${acceptedCount}, rejected=${rejectedCount})`
    );

    // Leave generous allowances so repeated runs stay deterministic.
    await api.request('PATCH', `/plans/${setup.accountPlanId}`, {
      monthlyAllowance: (used + 10_000n).toString(),
    });
    await api.request('PATCH', `/plans/${setup.userPlanId}`, { monthlyAllowance: '100' });
    await api.request('PATCH', `/plans/${setup.plusPlanId}`, { monthlyAllowance: '200' });
  } catch (err) {
    if (!(err instanceof DemoError)) throw err;
    report.check('demo aborted', false, err.message);
  }

  report.summary();
  return report.failureCount === 0 ? 0 : 1;
}
