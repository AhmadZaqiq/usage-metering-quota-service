// Probe Usage Metering service under controlled HTTP load and capture the
// full autocannon result as JSON. Campaign-only tool (untracked).
//
// Usage:
//   node run-stage.mjs --label a-c100 --connections 100 --duration 60 \
//     --key <apiKey> [--user-id u1] [--units 1] [--url http://localhost:3100] \
//     --out ../raw/a-c100.json
//
// Every request gets a unique idempotency key (UUID), so throughput stages
// measure real consumption, not idempotent replays.
import autocannon from 'autocannon';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:3100' },
    connections: { type: 'string', default: '10' },
    duration: { type: 'string', default: '60' },
    pipelining: { type: 'string', default: '1' },
    units: { type: 'string', default: '1' },
    key: { type: 'string' },
    'user-id': { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
});

const label = values.label ?? `stage-${Date.now()}`;
const url = values.url;
const connections = Number(values.connections);
const duration = Number(values.duration);
const pipelining = Number(values.pipelining);
const units = values.units;
const apiKey = values.key;
const userId = values['user-id'];
const out = values.out ?? `../raw/${label}.json`;

if (!apiKey) {
  console.error('missing --key');
  process.exit(2);
}

let requestCount = 0;

const options = {
  url,
  connections,
  duration,
  pipelining,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  requests: [
    {
      method: 'POST',
      path: '/usage',
      body: '{}',
      setupRequest: (params) => {
        requestCount += 1;
        const body = JSON.stringify({
          units,
          idempotencyKey: `${label}-${requestCount}-${randomUUID()}`,
          ...(userId ? { userId } : {}),
        });
        return {
          ...params,
          body,
          headers: {
            ...params.headers,
            'Content-Type': 'application/json',
          },
        };
      },
    },
  ],
};

const startedAt = new Date().toISOString();
const t0 = process.hrtime.bigint();

autocannon(options, (err, result) => {
  if (err) {
    console.error(`${label}: autocannon failed: ${err.message}`);
    process.exit(1);
  }
  const elapsedSec = Number(process.hrtime.bigint() - t0) / 1e9;
  const statusCounts = {};
  for (const [code, stat] of Object.entries(result.statusCodeStats ?? {})) {
    statusCounts[code] = stat.count;
  }
  const payload = {
    meta: {
      label,
      url,
      connections,
      duration,
      pipelining,
      units,
      userId: userId ?? null,
      keyPrefix: apiKey.slice(0, 14),
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedSec: Number(elapsedSec.toFixed(3)),
      requestsGenerated: requestCount,
    },
    statusCounts,
    result,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 2));
  const r = result;
  const statuses = Object.entries(statusCounts)
    .map(([code, n]) => `${code}:${n}`)
    .join(' ');
  console.log(
    `${label} c=${connections} d=${duration}s rps=${r.requests.mean.toFixed(1)} ` +
      `total=${r.requests.total} p50=${r.latency.p50} p90=${r.latency.p90} p99=${r.latency.p99} ` +
      `max=${r.latency.max} errors=${r.errors} timeouts=${r.timeouts} non2xx=${r.non2xx} ` +
      `resets=${r.resets} statuses[${statuses}]`
  );
  process.exit(0);
});
