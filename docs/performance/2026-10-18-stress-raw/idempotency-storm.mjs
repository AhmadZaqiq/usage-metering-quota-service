// Idempotency storm: N concurrent requests with the SAME key must produce
// exactly 1 accepted row and exactly +units on the account counter.
// Usage: node idempotency-storm.mjs <baseUrl> <apiKey> <stormSize> <units>
const [base, key, stormStr, unitsStr] = process.argv.slice(2);
const storm = Number(stormStr ?? 100);
const units = unitsStr ?? "1";
const idemKey = `storm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const before = await fetch(`${base}/usage`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ units, idempotencyKey: `warmup-${Date.now()}` }),
}).then((r) => r.json());

const results = await Promise.all(
  Array.from({ length: storm }, () =>
    fetch(`${base}/usage`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ units, idempotencyKey: idemKey }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))
  )
);

const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const decisions = {};
for (const r of results) {
  const d = r.body.decision ?? r.body.error?.code ?? "unknown";
  decisions[d] = (decisions[d] ?? 0) + 1;
}
const remainings = new Set(results.filter((r) => r.status === 200).map((r) => r.body.accountRemaining));
const reasons = new Set(results.map((r) => r.body.rejectionReason).filter(Boolean));

console.log(JSON.stringify({
  idempotencyKey: idemKey,
  storm,
  units,
  statusCounts: byStatus,
  decisionCounts: decisions,
  distinctAccountRemainings: [...remainings],
  rejectionReasons: [...reasons],
  remainingBefore: before.accountRemaining,
}, null, 2));
