import { parseArgs } from 'util';
import * as fs from 'fs';

/**
 * Example tenant client.
 *
 * Commands:
 *  - demo (default): runs an end-to-end scenario walkthrough against a
 *    running service — health gate, accepted usage, user/account/per-request
 *    rejections, immediate plan changes, idempotent replay, credential and
 *    input rejections, history + assignment summary. Output is deterministic
 *    because the demo normalizes plan allowances before asserting remainings.
 *    When DATABASE_URL is set, a successful demo finishes by verifying the
 *    accounting invariants in-process.
 *  - consume: send one POST /usage request (legacy -n/-i flags map through).
 *  - usage --userId: GET /usage filtered to a single user.
 *  - history: GET /usage, paginated.
 *
 * Exit codes: 0 = success, 1 = failure. The full API key is never printed;
 * only the public prefix is shown.
 */

const DEFAULT_KEY_FILE = '/run/secrets/api-key';
const DEFAULT_BASE_URL = 'http://localhost:3000';
const PROBE_ALLOWANCE = 1_000_000n;
const ACCOUNT_HEADROOM = 40n;

const HELP = `Usage: client [command] [options]

Commands:
  demo                       Run the end-to-end demo scenario walkthrough (default).
                             With DATABASE_URL set, also verifies accounting invariants.
  consume                    Send one POST /usage request.
      --userId <id>          clientUserId (optional; omitted = account-scoped request)
  -n, --units <units>        Positive integer units, string form (required)
  -i, --requestId <key>      Client idempotency key; send the same value to retry (required)
                             --idempotencyKey is accepted as a deprecated alias for -i
  usage                      GET /usage filtered to one user.
      --userId <id>          clientUserId to filter by (required)
      --page <n>             Page number (default 1)
      --limit <n>            Page size (default 50)
  history                    GET /usage, paginated.
      --page <n>             Page number (default 1)
      --limit <n>            Page size (default 50)

Options:
  -u, --url <url>          Base URL of the service (default: ${DEFAULT_BASE_URL}, env BASE_URL)
  -k, --key <api-key>      API key (otherwise read from --key-file)
      --key-file <path>    API key file (default: ${DEFAULT_KEY_FILE})
  -h, --help               Show this help

Exit codes: 0 success, 1 failure
`;

type Command = 'demo' | 'consume' | 'usage' | 'history';

interface Options {
  command: Command;
  baseUrl: string;
  key?: string;
  keyFile: string;
  units?: string;
  userId?: string;
  requestId?: string;
  page?: number;
  limit?: number;
}

function parseOptions(): Options {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: 'string', short: 'u', default: process.env.BASE_URL ?? DEFAULT_BASE_URL },
      key: { type: 'string', short: 'k' },
      keyFile: { type: 'string', default: DEFAULT_KEY_FILE },
      units: { type: 'string', short: 'n' },
      userId: { type: 'string' },
      requestId: { type: 'string', short: 'i' },
      // Deprecated alias for requestId.
      idempotencyKey: { type: 'string' },
      page: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  let key = values.key;
  if (!key) {
    try {
      key = fs.readFileSync(values.keyFile, 'utf8').trim();
    } catch {
      // Reported by resolveKey with a clear message.
    }
  }

  // Legacy shape: flags without a subcommand mean a single consume request.
  let command = positionals[0] as Command | undefined;
  if (
    command === undefined &&
    (values.units !== undefined || values.requestId !== undefined || values.idempotencyKey !== undefined)
  ) {
    command = 'consume';
  }
  if (command === undefined) {
    command = 'demo';
  }
  if (!['demo', 'consume', 'usage', 'history'].includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  const parsePositiveInt = (raw: string | undefined, label: string): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`${label} must be a positive integer, got: ${raw}`);
      process.exit(1);
    }
    return n;
  };

  return {
    command,
    baseUrl: values.url,
    key,
    keyFile: values.keyFile,
    units: values.units,
    userId: values.userId,
    requestId: values.requestId ?? values.idempotencyKey,
    page: parsePositiveInt(values.page, '--page'),
    limit: parsePositiveInt(values.limit, '--limit'),
  };
}

function requireKey(opts: Options): string {
  if (!opts.key) {
    console.error(
      `No API key available. Pass -k <key> or place the key in ${opts.keyFile} (written by bootstrap).`
    );
    process.exit(1);
  }
  return opts.key;
}

/** Public identification only — the prefix is not secret; the suffix is. */
function maskKey(key: string): string {
  return `${key.split('.')[0]}.***`;
}

interface ApiResponse {
  status: number;
  data: Record<string, unknown>;
}

class DemoError extends Error {}

class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string | undefined
  ) {}

  async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    options?: { auth?: boolean; keyOverride?: string }
  ): Promise<ApiResponse> {
    const useAuth = options?.auth !== false;
    const authKey = options?.keyOverride ?? this.key;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (useAuth && authKey) {
      headers.Authorization = `Bearer ${authKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new DemoError(`Request ${method} ${path} failed: ${(err as Error).message}`);
    }

    let data: Record<string, unknown> = {};
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = { raw: text.slice(0, 200) };
      }
    }
    return { status: response.status, data };
  }
}

class ScenarioReport {
  private readonly results: { name: string; ok: boolean; detail: string }[] = [];

  check(name: string, ok: boolean, detail = ''): void {
    this.results.push({ name, ok, detail });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  }

  /** Setup step: failure aborts the demo (later assertions would be noise). */
  expect(name: string, cond: boolean, detail = ''): asserts cond {
    this.check(name, cond, detail);
    if (!cond) {
      throw new DemoError(`Setup failed: ${name}${detail ? ` (${detail})` : ''}`);
    }
  }

  get failureCount(): number {
    return this.results.filter((r) => !r.ok).length;
  }

  summary(): void {
    const failed = this.failureCount;
    const total = this.results.length;
    console.log(`\nScenario summary: ${total - failed}/${total} checks passed`);
    if (failed > 0) {
      for (const r of this.results.filter((x) => !x.ok)) {
        console.log(`  FAILED: ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
      }
    }
  }
}

function errCode(res: ApiResponse): string {
  const error = res.data.error as { code?: string } | undefined;
  return error?.code ?? '<none>';
}

async function healthGate(api: ApiClient, report: ScenarioReport): Promise<void> {
  const ready = await api.request('GET', '/health/ready');
  report.expect(
    'service is ready (/health/ready = 200)',
    ready.status === 200,
    `got ${ready.status}`
  );
}

async function ensureUserPlan(
  api: ApiClient,
  report: ScenarioReport,
  plans: {
    id: number;
    name: string;
    type: string;
    ownerAccountId: number | null;
    monthlyAllowance: string;
    maxUnitsPerRequest: string;
  }[],
  name: string,
  monthlyAllowance: string,
  maxUnitsPerRequest: string
): Promise<{ planId: number }> {
  const existing = plans.find((p) => p.type === 'user' && p.name === name);
  if (!existing) {
    const created = await api.request('POST', '/plans', {
      name,
      type: 'user',
      monthlyAllowance,
      maxUnitsPerRequest,
    });
    report.expect(`created ${name}`, created.status === 201, `got ${created.status}`);
    return { planId: (created.data as unknown as { id: number }).id };
  }

  const patched = await api.request('PATCH', `/plans/${existing.id}`, {
    monthlyAllowance,
    maxUnitsPerRequest,
  });
  report.expect(`normalized ${name} allowances`, patched.status === 200, `got ${patched.status}`);
  return { planId: existing.id };
}

async function ensureDemoPlansAndUsers(
  api: ApiClient,
  report: ScenarioReport,
  runId: string
): Promise<{
  userIds: string[];
  accountPlanId: number;
  userPlanId: number;
  plusPlanId: number;
}> {
  const userIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const clientUserId = `demo-${runId}-${i}`;
    const res = await api.request('POST', '/users', { clientUserId });
    report.expect(`created demo user ${clientUserId}`, res.status === 201, `got ${res.status}`);
    userIds.push(clientUserId);
  }

  const plansRes = await api.request('GET', '/plans');
  report.expect('listed plans', plansRes.status === 200, `got ${plansRes.status}`);
  const plans = plansRes.data as unknown as {
    id: number;
    name: string;
    type: string;
    ownerAccountId: number | null;
    monthlyAllowance: string;
    maxUnitsPerRequest: string;
  }[];

  const userPlans = await ensureUserPlan(api, report, plans, 'Demo User Plan', '100', '10');
  // Plus plan: same setup but a higher allowance and a higher per-request cap,
  // so demo-3 accepts units demo-1/demo-2 would reject (per-plan decision).
  const plusPlans = await ensureUserPlan(api, report, plans, 'Demo User Plan Plus', '200', '20');

  // demo-1 and demo-2 share the small user plan; demo-3 gets the Plus plan so
  // the same units yield different remainings and different accept/reject.
  const smallAssign = await api.request('POST', '/assignments', {
    userId: userIds[0],
    planId: userPlans.planId,
  });
  report.expect(
    `assigned Demo User Plan to ${userIds[0]}`,
    smallAssign.status === 201,
    `got ${smallAssign.status}`
  );
  const smallAssign2 = await api.request('POST', '/assignments', {
    userId: userIds[1],
    planId: userPlans.planId,
  });
  report.expect(
    `assigned Demo User Plan to ${userIds[1]}`,
    smallAssign2.status === 201,
    `got ${smallAssign2.status}`
  );
  const plusAssign = await api.request('POST', '/assignments', {
    userId: userIds[2],
    planId: plusPlans.planId,
  });
  report.expect(
    `assigned Demo User Plan Plus to ${userIds[2]}`,
    plusAssign.status === 201,
    `got ${plusAssign.status}`
  );

  const currentRes = await api.request('GET', '/assignments/current');
  report.expect('read current assignments', currentRes.status === 200, `got ${currentRes.status}`);
  const current = currentRes.data as unknown as { account: { planId: number } | null };
  report.expect('an account plan is currently assigned', current.account !== null);
  const assignedPlanId = current.account.planId;

  let accountPlan: { id: number; ownerAccountId: number | null } | undefined = plans.find(
    (p) => p.id === assignedPlanId
  );

  if (accountPlan && accountPlan.ownerAccountId === null) {
    // System plans are immutable by design: switch to an account-owned plan.
    const existingDemoPlan = plans.find(
      (p) => p.type === 'account' && p.name === 'Demo Account Plan'
    );
    if (existingDemoPlan) {
      accountPlan = existingDemoPlan;
    } else {
      const created = await api.request('POST', '/plans', {
        name: 'Demo Account Plan',
        type: 'account',
        monthlyAllowance: String(PROBE_ALLOWANCE),
        maxUnitsPerRequest: '1000',
      });
      report.expect('created Demo Account Plan', created.status === 201, `got ${created.status}`);
      accountPlan = created.data as unknown as { id: number; ownerAccountId: number | null };
    }
    const assigned = await api.request('POST', '/assignments', { planId: accountPlan.id });
    report.expect('assigned Demo Account Plan', assigned.status === 201, `got ${assigned.status}`);
  }

  report.expect(
    'account plan is account-owned (mutable)',
    accountPlan !== undefined && accountPlan.ownerAccountId !== null
  );

  const normalized = await api.request('PATCH', `/plans/${accountPlan.id}`, {
    monthlyAllowance: String(PROBE_ALLOWANCE),
  });
  report.expect(
    'normalized account plan allowance for deterministic math',
    normalized.status === 200,
    `got ${normalized.status}`
  );

  return { userIds, accountPlanId: accountPlan.id, userPlanId: userPlans.planId, plusPlanId: plusPlans.planId };
}

async function probeUsed(api: ApiClient, report: ScenarioReport, runId: string): Promise<bigint> {
  const probe = await api.request('POST', '/usage', {
    units: '1',
    requestId: `demo-probe-${runId}`,
  });
  if (probe.status !== 200 || probe.data.decision !== 'accepted') {
    throw new DemoError(
      `Probe request failed (status ${probe.status}, decision ${String(probe.data.decision)}): cannot establish current usage`
    );
  }
  const remaining = BigInt(String(probe.data.accountRemaining));
  report.expect('probe request accepted', true, `accountRemaining=${remaining}`);
  // accountRemaining in an accepted response is the balance AFTER the
  // probe's own consumption, so current usage = allowance - remaining.
  return PROBE_ALLOWANCE - remaining;
}

async function runDemo(opts: Options, key: string): Promise<number> {
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

async function runConsume(opts: Options, key: string): Promise<number> {
  if (!opts.units || !opts.requestId) {
    console.error('consume command requires both -n <units> and -i <request-id>.');
    console.error('Run with --help for usage.');
    return 1;
  }

  const api = new ApiClient(opts.baseUrl, key);
  const body: Record<string, unknown> = {
    units: opts.units,
    requestId: opts.requestId,
  };
  if (opts.userId) body.userId = opts.userId;

  console.log(`POST ${opts.baseUrl}/usage  (key ${maskKey(key)})`);
  const res = await api.request('POST', '/usage', body);
  console.log(`Status: ${res.status}`);
  console.log(JSON.stringify(res.data, null, 2));
  return res.status >= 200 && res.status < 300 ? 0 : 1;
}

function historyQuery(opts: Options): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.page !== undefined) params.set('page', String(opts.page));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  return params;
}

async function printHistory(opts: Options, key: string, params: URLSearchParams): Promise<number> {
  const query = params.toString();
  const path = query ? `/usage?${query}` : '/usage';
  const api = new ApiClient(opts.baseUrl, key);
  console.log(`GET ${opts.baseUrl}${path}  (key ${maskKey(key)})`);
  const res = await api.request('GET', path);
  console.log(`Status: ${res.status}`);
  console.log(JSON.stringify(res.data, null, 2));
  return res.status >= 200 && res.status < 300 ? 0 : 1;
}

async function runUsage(opts: Options, key: string): Promise<number> {
  if (!opts.userId) {
    console.error('usage command requires --userId <clientUserId>.');
    console.error('Run with --help for usage.');
    return 1;
  }
  const params = historyQuery(opts);
  params.set('userId', opts.userId);
  return await printHistory(opts, key, params);
}

async function runHistory(opts: Options, key: string): Promise<number> {
  return await printHistory(opts, key, historyQuery(opts));
}

/**
 * Verify accounting invariants in-process after a successful demo. Skipped
 * (not failed) when DATABASE_URL is unset, because verify-invariants connects
 * to PostgreSQL directly — importing it without the env would throw.
 */
async function runInvariantStep(): Promise<{ ran: boolean; ok: boolean }> {
  if (!process.env.DATABASE_URL) {
    console.log('  Invariant check skipped: DATABASE_URL not set.');
    return { ran: false, ok: true };
  }
  try {
    const { verify } = await import('./verify-invariants.js');
    const violations = await verify(process.env.BOOTSTRAP_ACCOUNT_NAME);
    if (violations.length > 0) {
      console.error(`\n${violations.length} invariant violation(s):`);
      for (const v of violations) {
        console.error(`  [${v.check}] ${v.detail}`);
      }
      return { ran: true, ok: false };
    }
    return { ran: true, ok: true };
  } catch (err) {
    console.error(`Invariant check failed to run: ${(err as Error).message}`);
    return { ran: true, ok: false };
  }
}

async function main(): Promise<number> {
  const opts = parseOptions();
  const key = requireKey(opts);

  switch (opts.command) {
    case 'consume':
      return await runConsume(opts, key);
    case 'usage':
      return await runUsage(opts, key);
    case 'history':
      return await runHistory(opts, key);
    case 'demo':
    default: {
      const demoCode = await runDemo(opts, key);
      if (demoCode !== 0) {
        return demoCode;
      }
      console.log('All demo assertions passed.');

      const invariants = await runInvariantStep();
      if (!invariants.ran) {
        return 0;
      }
      if (!invariants.ok) {
        return 1;
      }
      console.log('All accounting invariants passed.');
      return 0;
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Client failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
