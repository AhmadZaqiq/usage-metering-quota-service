// Idempotency correctness probe. Campaign-only tool (untracked).
//
// Modes:
//   same     - N concurrent requests, ONE key, identical payload
//   conflict - N concurrent requests, ONE key, two different payloads
//
// Usage: node probe-idempotency.mjs <baseUrl> <apiKey> <mode> <count> <unitsA> [unitsB] [userId]
// Prints a JSON summary; DB verification is done separately with psql.
const [base, key, mode, countStr, unitsA, unitsBArg, userId] = process.argv.slice(2);
const count = Number(countStr ?? 100);
const unitsB = unitsBArg ?? '2';
const idemKey = `probe-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function send(units) {
  const res = await fetch(`${base}/usage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      units,
      idempotencyKey: idemKey,
      ...(userId ? { userId } : {}),
    }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return {
    status: res.status,
    decision: body?.decision ?? null,
    reason: body?.rejectionReason ?? null,
    code: body?.error?.code ?? null,
    accountRemaining: body?.accountRemaining ?? null,
    userRemaining: body?.userRemaining ?? null,
  };
}

const started = Date.now();
const tasks = Array.from({ length: count }, (_, i) => {
  const units = mode === 'conflict' && i % 2 === 1 ? unitsB : unitsA;
  return send(units);
});
const results = await Promise.all(tasks);

const tally = (field) => {
  const out = {};
  for (const r of results) {
    const v = r[field] ?? 'none';
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
};

const summary = {
  idempotencyKey: idemKey,
  mode,
  count,
  unitsA,
  unitsB: mode === 'conflict' ? unitsB : undefined,
  userId: userId ?? null,
  wallMs: Date.now() - started,
  statusCounts: tally('status'),
  decisionCounts: tally('decision'),
  rejectionReasons: tally('reason'),
  errorCodes: tally('code'),
  distinctAccountRemainings: [...new Set(results.map((r) => r.accountRemaining).filter((v) => v !== null))],
  distinctUserRemainings: [...new Set(results.map((r) => r.userRemaining).filter((v) => v !== null))],
  sampleBody: results[0],
};
console.log(JSON.stringify(summary, null, 2));
