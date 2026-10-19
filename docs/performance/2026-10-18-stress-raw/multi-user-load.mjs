// Multi-user contention: W workers, each hammering one user for D seconds
// with unique idempotency keys. Prints per-worker counts.
// Usage: node multi-user-load.mjs <baseUrl> <apiKey> <durationSec> <units> u1,u2,...
const [base, key, durStr, unitsStr, usersArg] = process.argv.slice(2);
const duration = Number(durStr ?? 10);
const units = unitsStr ?? "1";
const users = (usersArg ?? "stress-u1").split(",");

const worker = async (user) => {
  const deadline = Date.now() + duration * 1000;
  let sent = 0, ok = 0, rejected = 0, err = 0, lastRemaining = null;
  let i = 0;
  while (Date.now() < deadline) {
    i += 1;
    try {
      const res = await fetch(`${base}/usage`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          units,
          idempotencyKey: `mu-${user}-${Date.now()}-${i}`,
          userId: user,
        }),
      });
      sent += 1;
      if (res.status === 200) {
        const body = await res.json();
        if (body.decision === "accepted") { ok += 1; lastRemaining = body.userRemaining; }
        else rejected += 1;
      } else {
        err += 1;
      }
    } catch {
      err += 1;
    }
  }
  return { user, sent, ok, rejected, err, lastUserRemaining: lastRemaining };
};

const started = Date.now();
const results = await Promise.all(users.map(worker));
console.log(JSON.stringify({ durationSec: duration, wallMs: Date.now() - started, results }, null, 2));
