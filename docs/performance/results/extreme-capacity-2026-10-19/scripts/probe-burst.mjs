// Concurrent burst with unique idempotency keys. Campaign-only tool (untracked).
// Used for quota-boundary races: N simultaneous requests, each with its own
// key, against an account/user with a known remaining allowance.
//
// Usage: node probe-burst.mjs <baseUrl> <apiKey> <count> <units> [userId]
const [base, key, countStr, units, userId] = process.argv.slice(2);
const count = Number(countStr ?? 100);
const started = Date.now();

const results = await Promise.all(
  Array.from({ length: count }, async (_, i) => {
    try {
      const res = await fetch(`${base}/usage`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          units,
          idempotencyKey: `burst-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
          ...(userId ? { userId } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      return {
        status: res.status,
        decision: body?.decision ?? null,
        reason: body?.rejectionReason ?? null,
        accountRemaining: body?.accountRemaining ?? null,
        userRemaining: body?.userRemaining ?? null,
      };
    } catch (err) {
      return { status: 0, error: err.message };
    }
  })
);

const tally = (field) => {
  const out = {};
  for (const r of results) {
    const v = r[field] ?? 'none';
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
};
const accepted = results.filter((r) => r.decision === 'accepted');
const rejected = results.filter((r) => r.decision === 'rejected');
const acctRem = results.map((r) => r.accountRemaining).filter((v) => v !== null).map(Number);
const userRem = results.map((r) => r.userRemaining).filter((v) => v !== null).map(Number);

console.log(
  JSON.stringify(
    {
      count,
      units,
      userId: userId ?? null,
      wallMs: Date.now() - started,
      statusCounts: tally('status'),
      decisionCounts: tally('decision'),
      rejectionReasons: tally('reason'),
      acceptedUnits: accepted.length * Number(units),
      minAccountRemaining: acctRem.length ? Math.min(...acctRem) : null,
      maxAccountRemaining: acctRem.length ? Math.max(...acctRem) : null,
      minUserRemaining: userRem.length ? Math.min(...userRem) : null,
    },
    null,
    2
  )
);
