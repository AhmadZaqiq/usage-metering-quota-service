# Workload Coverage and Bottleneck Analysis — 2026-10-20

Companion to [2026-10-19-baseline.md](./2026-10-19-baseline.md). That report
records the initial single-run baseline. This report adds:

- repeated warm runs to quantify run-to-run variance,
- the extended workload modes now built into `npm run loadtest`
  (multi-user, duplicate retries, near-quota),
- a two-account parallel run showing that the counter lock is per-account,
- measured logging overhead,
- a direct PostgreSQL timing probe of the usage transaction,
- the bottlenecks that were considered for optimization and why they were
  kept as-is.

All numbers come from one WSL2 development machine running the Docker Compose
stack. They characterize that environment only.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-10-20, 00:35–01:05 UTC |
| Host | Linux x86_64 (WSL2), 12 CPU cores, 7.9 GB RAM |
| App runtime | `node:22-alpine` in Docker Compose, single container |
| Database | PostgreSQL 16.15 (`postgres:16-alpine`) in Docker Compose |
| Rate limiter | `RATE_LIMIT_MAX=10000000` during the measurement window only |
| Code state | `main` @ `93d0d80` plus pending test/load-test tooling changes; **zero diff in server code** vs the `b098f05` baseline commit (`git diff b098f05 -- src/` contains only tests and load-test scripts) |
| Load generator | autocannon 7.15.0 via `npm run loadtest` on the host |

## Method

Identical to the baseline report: account-scoped `POST /usage`, `units=1`,
unique idempotency keys, pipelining 1, 30 s × 10 connections unless stated
otherwise, 5 s warm-up run before each measured run, rate limit raised for the
window and restored afterwards. Accounting verified with
`dist/scripts/verify-invariants.js` before and after.

## 1. Warm repeat series (same workload as the baseline)

| Run | Conditions | RPS | p50 | p90 | p99 | Mean | Errors |
|-----|-----------|-----|-----|-----|-----|------|--------|
| Baseline (10-19) | `main @ b098f05`, debug + pretty logs | 120.44 | 79 | 96 | 146 | 82.32 | 0 |
| E1 (cold) | first run after image rebuild | 89.50 | 94 | 148 | 313 | 110.83 | 0 |
| E1b | warm, default config | 101.10 | 93 | 118 | 189 | 98.09 | 0 |
| E1c | warm, default config (repeat) | 114.37 | 82 | 100 | 166 | 86.64 | 0 |

All runs: 0 errors, 100% accepted, counters matched accepted deltas.

Reading:

- The cold run (89.50) is a real effect: the first measured run after a
  rebuild/restart carries JIT and page-cache warm-up cost. Always discard the
  first run.
- Warm runs on 2026-10-20 land between **101 and 114 RPS**; the historical
  single run measured 120.44. Server code is identical, methodology is
  identical — the spread is environmental (shared WSL2 machine, disk and
  scheduler state across days). Run-to-run variance within a session is about
  ±7%.
- Throughput is connection-latency-bound: 10 connections × ~87–98 ms mean
  latency ≈ 102–115 req/s, matching the measured RPS.

## 2. Logging overhead (isolation runs)

Same workload, only logging configuration changed:

| Run | Config | RPS | p50 | p99 |
|-----|--------|-----|-----|-----|
| E2 | `LOG_LEVEL=error` (no request logs), pretty transport on | 107.67 | 88 | 149 |
| E3 | `LOG_LEVEL=info`, JSON output, `NODE_ENV=production` (no pretty) | 104.77 | 90 | 169 |
| E4 | `LOG_LEVEL=info`, pretty transport on | 101.54 (15 s) | 93 | — |
| E1b | `LOG_LEVEL=debug`, pretty transport on (compose default) | 101.10 | 93 | 189 |

Findings:

- The per-request `INFO` line costs about **3–6%** throughput.
- The pino-pretty transport costs about **3%**.
- `LOG_LEVEL=debug` vs `info` makes **no difference**: the codebase contains
  no `debug`-level log statements (verified by grep), so both levels emit the
  same lines.
- Every logging variant sits inside the ±7% run-to-run noise band except the
  complete removal of request logs, which is not an acceptable production
  trade-off (request logs are a project requirement).

**Decision: no logging change.** The measured effect is at or below noise, and
request logging plus development-friendly pretty output are deliberate
choices.

## 3. Workload modes (decision-mix evidence)

Short runs proving behavior, not throughput claims:

| Workload | Result |
|----------|--------|
| `--users 10` (round-robin `loadtest-user-1..10`, shared account counter) | 396 accepted, 0 non-decision responses — user routing works under load |
| `--duplicate-every 5` (replay of previous key + payload) | 500 accepted + 102 duplicate retries sent; verifier afterwards: counters equal accepted rows exactly — **replays never double-charge** |
| `--near-quota --headroom 30` | primed allowance to `used + 30`; run: 30 accepted, 794 rejected with `account_quota_exceeded`; allowance restored to `used + 1,000,000` afterwards; rejected requests consumed 0 units |

## 4. Two-account parallel run (lock scope)

Two load-test accounts, two autocannon processes in parallel, 20 s × 10
connections each:

| Account | RPS | Accepted | Errors |
|---------|-----|----------|--------|
| loadtest-account | 81.30 | 1,626 | 0 |
| loadtest-account-2 | 81.05 | 1,621 | 0 |
| **Combined** | **162.35** | 3,247 | 0 |

Single-account warm runs average ≈ 107 RPS; two accounts together reach 162
RPS (each drops to ~81 because generator, app, and database share 12 vCPUs).
The counter row lock is **per account**, so throughput scales across tenants
until the machine saturates. There is no global lock.

## 5. Direct PostgreSQL timing probe

Executed with `\timing on` inside the database container, replaying the exact
statement sequence of the usage transaction on one account:

| Statement | Time |
|-----------|------|
| `SELECT ... FROM accounts ... FOR UPDATE` | 0.36 ms |
| `clock_timestamp()` | 0.28 ms |
| counter upsert `ON CONFLICT DO UPDATE ... RETURNING` | 0.35 ms |
| assignment lookup | 0.30 ms |
| plan lookup | 0.30 ms |
| `usage_requests` insert | 0.36 ms |
| counter increment update | 0.30 ms |
| `api_keys` last-used update | 0.30 ms |
| **COMMIT (fsync)** | **3.3–4.4 ms** |
| **Total** | **≈ 5.5–6.5 ms** |

Control measurements: plain `SELECT 1` round trip = 0.4 ms; ten selects in one
transaction = 2.8 ms total. PostgreSQL is not latency-bound on round trips;
the commit flush dominates.

Application service time implied by the load test: 10 concurrent connections
at ~100 RPS ⇒ ≈ 9–10 ms per request end to end, of which ≈ 5.5 ms is the
database transaction and ≈ 4 ms is Node/Express/pino/pool overhead. Client
latency (~90 ms p50) is therefore almost entirely **queueing behind the
account row lock** — correct behavior for the no-overspend design.

## 6. Bottlenecks considered for optimization

| Candidate | Evidence | Decision |
|-----------|----------|----------|
| Remove per-account lock (optimistic CAS on counters) | Would raise single-tenant RPS toward the ~180 RPS implied by DB time | **Rejected.** The documented lock order (accounts → counters → api key) and admission-clock semantics are covered by concurrency and month-boundary tests; a redesign on the final day risks the project's core invariant for an unmeasurable gain on one machine. |
| `synchronous_commit=off` | Would remove most of the 3.3–4.4 ms commit cost (≈ 30%) | **Rejected.** A crash could drop acknowledged commits, re-opening spent quota and allowing duplicate consumption — exactly the failure the service exists to prevent. |
| Skip `api_keys` last-used write unless stale; fold clock read into the account-lock statement; fuse assignment+plan lookups | ≈ 0.7–1 ms per transaction (≈ 5–8%) | **Not attempted.** Below the measured ±7% noise floor; each change touches the serialized hot path where regression risk exceeds demonstrable benefit. |
| Drop pino-pretty / request logging | ≈ 3–6% | **Not attempted.** See section 2; logging is a requirement and the effect is within noise. |

The plateau of ≈ 100–120 single-tenant RPS is the intended cost of the
correctness design: serialized counter updates plus a durable commit per
accepted request. The two-account run shows the service is not globally
serialized.

## 7. Accounting evidence

Whole-database verifier (`verify-invariants.js`, INV-1…INV-8) after all runs:

```
Scope: all accounts; usage_requests: 49832 accepted, 1002 rejected
(rejected units excluded from counters by INV-1/INV-2)
All accounting invariants hold.
```

(Re-run after the final series; counts grow monotonically with each run, invariants
held after every individual run as well.)

## 8. Reproduction

```bash
# raise the rate limit for the window, then bootstrap two accounts
RATE_LIMIT_MAX=10000000 docker compose up -d app
docker compose run --rm -e BOOTSTRAP_ACCOUNT_NAME=loadtest-account \
  -e BOOTSTRAP_API_KEY_NAME=loadtest-key app node dist/scripts/bootstrap-loadtest.js
docker compose run --rm -e BOOTSTRAP_ACCOUNT_NAME=loadtest-account-2 \
  -e BOOTSTRAP_API_KEY_NAME=loadtest-key-2 app node dist/scripts/bootstrap-loadtest.js

# single-account baseline-style run (discard the first run after a rebuild)
export LOADTEST_API_KEY=<key-1>
npm run loadtest -- --duration 30 --connections 10

# extended workloads
npm run loadtest -- --users 10 --duration 30 --connections 10
npm run loadtest -- --duplicate-every 5 --duration 30 --connections 10
npm run loadtest -- --near-quota --headroom 50 --duration 30 --connections 10

# two-account scaling: run both in parallel with the two keys
LOADTEST_API_KEY=<key-1> npm run loadtest -- --duration 20 --connections 10 &
LOADTEST_API_KEY=<key-2> npm run loadtest -- --duration 20 --connections 10 &

# verify, then restore the default rate limit
docker compose run --rm app node dist/scripts/verify-invariants.js
docker compose up -d app
```

## Limitations

- One shared WSL2 machine; no TLS, reverse proxy, or app replicas.
- Single 30 s runs per condition; the variance table (section 1) bounds
  run-to-run spread but no confidence intervals are claimed.
- Rate limit raised during windows; the default 100 req/60 s produces 429s by
  design and is not part of these measurements.
- Latency percentiles are autocannon's histogram output (`p95` is not emitted
  and is not interpolated).
