import { parseArgs } from 'util';
// @ts-expect-error - autocannon doesn't have types but we use it as a dev dependency
import autocannon from 'autocannon';

interface LoadTestArgs {
  url: string;
  duration: number;
  connections: number;
  pipelining: number;
  units: number;
  skipBootstrap: boolean;
  userId?: string;
  users: number;
  duplicateEvery: number;
  nearQuota: boolean;
  headroom: number;
}

interface AutocannonResult {
  requests: {
    mean: number;
    total: number;
    started: number;
    finished: number;
    sent: number;
  };
  latency: {
    p50: number;
    p90: number;
    p99: number;
    max: number;
    mean: number;
    stddev: number;
    [key: string]: number;
  };
  throughput: {
    mean: number;
  };
  errors: number;
  timeouts: number;
  non2xx: number;
  mismatches: number;
  statusCodes?: Record<string, number>;
}

/** Tally of parsed usage responses and sent duplicates for one run. */
interface DecisionTally {
  accepted: number;
  rejected: number;
  noDecision: number;
  duplicatesSent: number;
  reasons: Record<string, number>;
}

function parseCliArgs(): LoadTestArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: 'string', short: 'u', default: 'http://localhost:3000' },
      duration: { type: 'string', short: 'd', default: '10' },
      connections: { type: 'string', short: 'c', default: '10' },
      pipelining: { type: 'string', short: 'p', default: '1' },
      units: { type: 'string', short: 'n', default: '1' },
      skipBootstrap: { type: 'boolean', default: false },
      userId: { type: 'string' },
      users: { type: 'string', default: '0' },
      'duplicate-every': { type: 'string', default: '0' },
      'near-quota': { type: 'boolean', default: false },
      headroom: { type: 'string', default: '50' },
    },
    strict: true,
    allowPositionals: false,
  });

  const int = (raw: string, label: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      console.error(`${label} must be a non-negative integer, got: ${raw}`);
      process.exit(1);
    }
    return n;
  };

  return {
    url: values.url,
    duration: int(values.duration, '--duration'),
    connections: int(values.connections, '--connections'),
    pipelining: int(values.pipelining, '--pipelining'),
    units: int(values.units, '--units'),
    skipBootstrap: values.skipBootstrap === true,
    userId: values.userId,
    users: int(values.users, '--users'),
    duplicateEvery: int(values['duplicate-every'], '--duplicate-every'),
    nearQuota: values['near-quota'] === true,
    headroom: int(values.headroom, '--headroom'),
  };
}

function validateLocalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('URL must use http or https protocol');
    }
    const hostname = parsed.hostname;
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLocal) {
      throw new Error(
        `Refusing to run load test against non-local target: ${hostname}. ` +
          `Load tests must target localhost only. ` +
          `Use --url=http://localhost:3000 or set a local target explicitly.`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('non-local target')) {
      throw e;
    }
    throw new Error(`Invalid URL: ${url}`);
  }
}

async function waitForServer(url: string, maxRetries = 30): Promise<void> {
  const healthUrl = new URL('/health/live', url).toString();
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

function requireApiKey(): string {
  // The API key comes only from the environment so a committed file or shell
  // history in a script can never pick it up implicitly.
  const apiKey = process.env.LOADTEST_API_KEY;
  if (!apiKey) {
    console.error(
      'LOADTEST_API_KEY environment variable not set.\n' +
        "Run 'npm run bootstrap:loadtest' first to create a test account and API key,\n" +
        'then set LOADTEST_API_KEY=your_generated_key before running the load test.'
    );
    process.exit(1);
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// Near-quota priming: the workload required by the performance plan ("requests
// near quota exhaustion"). Uses the tenant's own API — GET /assignments/current,
// GET /plans, PATCH /plans — so it exercises the same authenticated path as
// any client. The plan allowance is raised back after the run so later runs
// start from the documented ~1M headroom.
// ---------------------------------------------------------------------------

interface QuotaPriming {
  planId: number;
  baseAllowance: bigint;
  restoreAllowance(): Promise<void>;
}

async function apiJson(
  url: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(new URL(path, url).toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

async function primeNearQuota(
  url: string,
  apiKey: string,
  headroom: number
): Promise<QuotaPriming> {
  const current = (await apiJson(url, apiKey, 'GET', '/assignments/current')) as {
    account: { planId: number } | null;
  };
  if (!current.account) {
    throw new Error('No current account plan; run bootstrap:loadtest first');
  }
  const planId = current.account.planId;
  const plan = (await apiJson(url, apiKey, 'GET', `/plans/${planId}`)) as {
    monthlyAllowance: string;
  };
  const allowance = BigInt(plan.monthlyAllowance);

  // Probe one unit to learn the exact remaining balance (rejected responses
  // also report accountRemaining, so this works at any exhaustion level).
  const probe = (await apiJson(url, apiKey, 'POST', '/usage', {
    units: '1',
    requestId: `loadtest-prime-${Date.now()}`,
  })) as { accountRemaining: string };
  const remaining = BigInt(probe.accountRemaining);
  const used = allowance - remaining;

  await apiJson(url, apiKey, 'PATCH', `/plans/${planId}`, {
    monthlyAllowance: (used + BigInt(headroom)).toString(),
  });

  console.log(
    `Near-quota priming: used=${used} remaining set to headroom=${headroom} (plan ${planId})`
  );

  return {
    planId,
    baseAllowance: allowance,
    async restoreAllowance(): Promise<void> {
      // Re-probe to capture post-run consumption, then restore a full 1M
      // headroom above actual usage so subsequent runs are unaffected.
      const probeAfter = (await apiJson(url, apiKey, 'POST', '/usage', {
        units: '1',
        requestId: `loadtest-restore-${Date.now()}`,
      })) as { accountRemaining: string };
      const allowanceNow = (
        (await apiJson(url, apiKey, 'GET', `/plans/${planId}`)) as { monthlyAllowance: string }
      ).monthlyAllowance;
      const usedNow = BigInt(allowanceNow) - BigInt(probeAfter.accountRemaining);
      await apiJson(url, apiKey, 'PATCH', `/plans/${planId}`, {
        monthlyAllowance: (usedNow + 1_000_000n).toString(),
      });
      console.log(`Near-quota restore: allowance set to ${usedNow + 1_000_000n}`);
    },
  };
}

// autocannon's fixed histogram emits p50, p75, p90, p97_5, p99 and max; it
// does not compute p95. We report only the percentiles it actually provides
// rather than interpolating a value it never measured.

function createLoadTestConfig(
  args: LoadTestArgs,
  apiKey: string,
  tally: DecisionTally
): autocannon.Options {
  let requestCounter = 0;
  // Shared across connections (single-threaded event loop), so a duplicate
  // retry can race the request it retries — exactly what clients do.
  let lastKey: string | null = null;
  let lastUserId: string | undefined;
  const userPool: string[] =
    args.users > 0 ? Array.from({ length: args.users }, (_, i) => `loadtest-user-${i + 1}`) : [];

  const nextBody = (): { body: string; userId?: string; requestId: string } => {
    const rotate = userPool.length > 0;
    const userId = rotate ? userPool[requestCounter % userPool.length] : args.userId;

    const isDuplicate =
      args.duplicateEvery > 0 &&
      lastKey !== null &&
      (requestCounter + 1) % args.duplicateEvery === 0;

    requestCounter += 1;
    const requestId = isDuplicate ? lastKey! : `loadtest-${Date.now()}-${requestCounter}-${Math.random().toString(36).slice(2, 11)}`;
    // A retry must carry the identical semantic payload (same user) so the
    // server replays instead of returning 409 for a different hash.
    const effectiveUserId = isDuplicate ? lastUserId : userId;
    if (!isDuplicate) {
      lastKey = requestId;
      lastUserId = userId;
    } else {
      tally.duplicatesSent += 1;
    }

    return {
      body: JSON.stringify({
        units: args.units.toString(),
        requestId,
        userId: effectiveUserId,
      }),
      userId: effectiveUserId,
      requestId,
    };
  };

  return {
    url: args.url,
    connections: args.connections,
    duration: args.duration,
    pipelining: args.pipelining,
    method: 'POST',
    title: 'Usage Metering Load Test',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    requests: [
      {
        method: 'POST',
        path: '/usage',
        body: JSON.stringify({
          units: args.units.toString(),
          requestId: 'loadtest-placeholder',
          userId: args.userId,
        }),
        setupRequest: (params: { body: string; headers: Record<string, string> }) => {
          const next = nextBody();
          return {
            ...params,
            body: next.body,
            headers: {
              ...params.headers,
              'Content-Length': Buffer.byteLength(next.body).toString(),
            },
          };
        },
        onResponse: (status: number, body: string) => {
          if (status !== 200 || !body) {
            tally.noDecision += 1;
            return;
          }
          try {
            const parsed = JSON.parse(body) as { decision?: string; rejectionReason?: string };
            if (parsed.decision === 'accepted') {
              tally.accepted += 1;
            } else if (parsed.decision === 'rejected') {
              tally.rejected += 1;
              const reason = parsed.rejectionReason ?? 'unknown';
              tally.reasons[reason] = (tally.reasons[reason] ?? 0) + 1;
            } else {
              tally.noDecision += 1;
            }
          } catch {
            tally.noDecision += 1;
          }
        },
      },
    ],
  };
}

function formatPercentile(value: number | undefined): string {
  if (value === undefined) return 'N/A';
  return `${value.toFixed(2)} ms`;
}

function printResults(result: autocannon.Result, args: LoadTestArgs, tally: DecisionTally) {
  console.log('\n========== LOAD TEST RESULTS ==========');
  console.log(`Target URL: ${args.url}`);
  console.log(`Duration: ${args.duration}s`);
  console.log(`Connections: ${args.connections}`);
  console.log(`Pipelining: ${args.pipelining}`);
  console.log(`Units per request: ${args.units}`);
  console.log(
    `Workload: ${args.users > 0 ? `${args.users} users in one account` : args.userId ? `user=${args.userId}` : 'account-scoped'}` +
      (args.duplicateEvery > 0 ? `, 1 duplicate retry every ${args.duplicateEvery} requests` : '') +
      (args.nearQuota ? `, near-quota headroom=${args.headroom}` : '')
  );
  console.log('--------------------------------------');

  // Throughput
  console.log('\n--- Throughput ---');
  console.log(`Requests/second: ${result.requests.mean.toFixed(2)} (mean)`);
  console.log(`  Total requests: ${result.requests.total}`);
  console.log(`  Requests sent: ${result.requests.sent}`);

  // Latency
  console.log('\n--- Latency (ms) ---');
  console.log(`  p50: ${formatPercentile(result.latency.p50)}`);
  console.log(`  p90: ${formatPercentile(result.latency.p90)}`);
  console.log(`  p99: ${formatPercentile(result.latency.p99)}`);
  console.log(`  max: ${formatPercentile(result.latency.max)}`);
  console.log(`  mean: ${formatPercentile(result.latency.mean)}`);
  console.log(`  stddev: ${formatPercentile(result.latency.stddev)}`);

  // Usage decisions (parsed from real response bodies)
  console.log('\n--- Usage decisions (from response bodies) ---');
  console.log(`  accepted: ${tally.accepted}`);
  console.log(`  rejected: ${tally.rejected}`);
  for (const [reason, count] of Object.entries(tally.reasons)) {
    console.log(`    - ${reason}: ${count}`);
  }
  console.log(`  non-decision responses: ${tally.noDecision}`);
  console.log(`  duplicate retries sent: ${tally.duplicatesSent}`);
  if (tally.noDecision > 0) {
    console.log(
      '  NOTE: non-decision responses indicate HTTP errors (status breakdown above); ' +
        '404s here mean loadtest-user-N is missing — re-run bootstrap:loadtest.'
    );
  }

  // Errors
  console.log('\n--- Errors ---');
  console.log(`  Errors: ${result.errors}`);
  console.log(`  Timeouts: ${result.timeouts}`);
  console.log(`  Non-2xx: ${result.non2xx}`);
  console.log(`  Mismatches: ${result.mismatches}`);

  // Latency distribution
  console.log('\n--- Latency Distribution ---');
  for (const [percentile, value] of Object.entries(result.latency)) {
    if (typeof value === 'number' && percentile.startsWith('p')) {
      console.log(`  ${percentile}: ${formatPercentile(value)}`);
    }
  }

  // Status codes (from autocannon 7.x)
  if (result.statusCodes) {
    console.log('\n--- HTTP Status Codes ---');
    for (const [code, count] of Object.entries(result.statusCodes)) {
      console.log(`  ${code}: ${count}`);
    }
  }

  // Self-reference: a load test that only reports latency leaves accounting
  // unverified. Print the exact command that proves counters still equal
  // accepted totals after this run.
  console.log('\n--- Post-run accounting check ---');
  console.log('  Verify counters equal accepted totals and invariants hold:');
  console.log(
    '    docker compose run --rm app node dist/scripts/verify-invariants.js'
  );
  console.log(
    '  (Duplicate retries must replay without consuming again — INV-1/INV-2 prove it.)'
  );

  console.log('\n========================================\n');
}

async function main() {
  const args = parseCliArgs();

  if (args.userId !== undefined && args.users > 0) {
    console.error('Use either --userId (one user) or --users N (rotation), not both.');
    process.exit(1);
  }

  // Safety check: only allow localhost targets
  validateLocalUrl(args.url);

  console.log('=== Usage Metering Load Test ===');
  console.log(`Target: ${args.url}`);
  console.log(`Duration: ${args.duration}s`);
  console.log(`Connections: ${args.connections}`);
  console.log(`Pipelining: ${args.pipelining}`);
  console.log('================================\n');

  // Wait for server to be ready
  console.log('Waiting for server to be ready...');
  await waitForServer(args.url);
  console.log('Server is ready.\n');

  const apiKey = requireApiKey();

  let priming: QuotaPriming | null = null;
  if (args.nearQuota) {
    priming = await primeNearQuota(args.url, apiKey, args.headroom);
  }

  const tally: DecisionTally = {
    accepted: 0,
    rejected: 0,
    noDecision: 0,
    duplicatesSent: 0,
    reasons: {},
  };

  const config = createLoadTestConfig(args, apiKey, tally);
  console.log('Starting load test...\n');

  try {
    const result = await autocannon(config);
    printResults(result, args, tally);

    // Exit with error code if there were significant errors
    if (result.errors > 0 || result.timeouts > 0) {
      console.warn('WARNING: Load test completed with errors/timeouts');
      process.exit(1);
    }
  } catch (error) {
    console.error('Load test failed:', error);
    process.exit(1);
  } finally {
    if (priming) {
      try {
        await priming.restoreAllowance();
      } catch (err) {
        console.error(
          `WARNING: near-quota restore failed: ${(err as Error).message}. ` +
            'Re-run bootstrap:loadtest or PATCH the plan allowance manually.'
        );
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err) => {
  console.error('Load test error:', err);
  process.exit(1);
});
