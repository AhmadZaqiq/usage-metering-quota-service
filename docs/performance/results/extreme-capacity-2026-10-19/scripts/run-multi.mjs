// Run N independent load probes in parallel (one per account / user) and
// aggregate their JSON results. Campaign-only tool (untracked).
//
// Usage:
//   node run-multi.mjs --label b-8x25 --accounts "key1,key2,...,key8" \
//     --connections-per 25 --duration 120 --out ../raw/b-8x25.json \
//     [--users "u1,u2,..."]   # optional: one distinct userId per account
//
// Each account runs in its own child process (own event loop, own socket
// pool), so the generator does not serialize across accounts.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    accounts: { type: 'string' },
    users: { type: 'string' },
    'connections-per': { type: 'string', default: '25' },
    duration: { type: 'string', default: '60' },
    pipelining: { type: 'string', default: '1' },
    units: { type: 'string', default: '1' },
    url: { type: 'string', default: 'http://localhost:3100' },
    out: { type: 'string' },
  },
  strict: true,
});

const label = values.label ?? `multi-${Date.now()}`;
const keys = (values.accounts ?? '').split(',').filter(Boolean);
const users = values.users ? values.users.split(',') : [];
const connPer = values['connections-per'];
const duration = values.duration;
const out = values.out ?? join(here, '..', 'raw', `${label}.json`);

if (keys.length === 0) {
  console.error('missing --accounts');
  process.exit(2);
}

function runChild(index, apiKey) {
  const childOut = join(
    dirname(out),
    `${label}--acct${String(index).padStart(2, '0')}.json`
  );
  const args = [
    join(here, 'run-stage.mjs'),
    '--label',
    `${label}-acct${index}`,
    '--url',
    values.url,
    '--connections',
    connPer,
    '--duration',
    duration,
    '--pipelining',
    values.pipelining,
    '--units',
    values.units,
    '--key',
    apiKey,
    '--out',
    childOut,
  ];
  if (users[index]) {
    args.push('--user-id', users[index]);
  }
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(readFileSync(childOut, 'utf8'));
      } catch {
        /* child failed to write results */
      }
      resolve({ index, code, stdout: stdout.trim(), stderr: stderr.trim(), childOut, parsed });
    });
  });
}

const startedAt = new Date().toISOString();
const children = await Promise.all(keys.map((k, i) => runChild(i, k)));

const totalRequests = children.reduce((a, c) => a + (c.parsed?.result?.requests?.total ?? 0), 0);
const totalErrors = children.reduce((a, c) => a + (c.parsed?.result?.errors ?? 0), 0);
const totalTimeouts = children.reduce((a, c) => a + (c.parsed?.result?.timeouts ?? 0), 0);
const totalNon2xx = children.reduce((a, c) => a + (c.parsed?.result?.non2xx ?? 0), 0);
const totalResets = children.reduce((a, c) => a + (c.parsed?.result?.resets ?? 0), 0);
const durationSec = Number(duration);
const perAccountRps = children.map((c) => c.parsed?.result?.requests?.mean ?? 0);
const p50s = children.map((c) => c.parsed?.result?.latency?.p50 ?? 0).sort((a, b) => a - b);
const p99s = children.map((c) => c.parsed?.result?.latency?.p99 ?? 0).sort((a, b) => a - b);
const maxes = children.map((c) => c.parsed?.result?.latency?.max ?? 0);
const statusAgg = {};
for (const c of children) {
  for (const [code, stat] of Object.entries(c.parsed?.result?.statusCodeStats ?? {})) {
    statusAgg[code] = (statusAgg[code] ?? 0) + (stat?.count ?? 0);
  }
}

const aggregate = {
  meta: {
    label,
    kind: 'multi-account',
    accounts: keys.length,
    usersPerAccount: users.length ? users : null,
    connectionsPerAccount: Number(connPer),
    totalConnections: keys.length * Number(connPer),
    durationSec,
    units: values.units,
    url: values.url,
    startedAt,
    finishedAt: new Date().toISOString(),
    keysPrefixes: keys.map((k) => k.slice(0, 14)),
    users,
  },
  aggregate: {
    totalRequests,
    requestsPerSec: Number((totalRequests / durationSec).toFixed(2)),
    perAccountRps,
    perAccountRpsMin: Math.min(...perAccountRps),
    perAccountRpsMax: Math.max(...perAccountRps),
    p50: { min: p50s[0] ?? null, median: p50s[Math.floor(p50s.length / 2)] ?? null, max: p50s[p50s.length - 1] ?? null },
    p99: { min: p99s[0] ?? null, median: p99s[Math.floor(p99s.length / 2)] ?? null, max: p99s[p99s.length - 1] ?? null },
    latencyMaxAcrossAccounts: Math.max(...maxes),
    errors: totalErrors,
    timeouts: totalTimeouts,
    non2xx: totalNon2xx,
    resets: totalResets,
    statusCodes: statusAgg,
  },
  children: children.map((c) => ({
    index: c.index,
    exitCode: c.code,
    stdout: c.stdout,
    stderr: c.stderr || undefined,
    summary: c.parsed
      ? {
          rps: c.parsed.result.requests.mean,
          total: c.parsed.result.requests.total,
          p50: c.parsed.result.latency.p50,
          p90: c.parsed.result.latency.p90,
          p99: c.parsed.result.latency.p99,
          max: c.parsed.result.latency.max,
          errors: c.parsed.result.errors,
          timeouts: c.parsed.result.timeouts,
          non2xx: c.parsed.result.non2xx,
          resets: c.parsed.result.resets,
          statusCodeStats: c.parsed.result.statusCodeStats,
          file: c.childOut,
        }
      : { error: 'no result file' },
  })),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(aggregate, null, 2));
const a = aggregate.aggregate;
console.log(
  `${label} accounts=${keys.length} x c=${connPer} (total ${aggregate.meta.totalConnections}) ` +
    `aggregateRps=${a.requestsPerSec} perAccount[min..max]=${a.perAccountRpsMin.toFixed(1)}..${a.perAccountRpsMax.toFixed(1)} ` +
    `p50[med]=${a.p50.median} p99[med]=${a.p99.median} errors=${a.errors} timeouts=${a.timeouts} non2xx=${a.non2xx} resets=${a.resets}`
);
