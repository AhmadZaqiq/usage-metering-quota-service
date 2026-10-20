# Request-Path Optimization — 2026-10-20

Baseline-versus-optimized comparison for the usage hot path. Same workload,
same machine, same Docker Compose stack on both sides; the only difference is
the two code changes listed below. Companion documents: the workload and
bottleneck analysis ([`2026-10-20-loadtest-workloads.md`](./2026-10-20-loadtest-workloads.md))
and the initial single-run baseline ([`2026-10-19-baseline.md`](./2026-10-19-baseline.md)).

## Environment

| Item | Value |
|------|-------|
| Date | 2026-10-20, 04:40–05:05 UTC |
| Host | Linux x86_64 (WSL2), 12 CPU cores, 7.9 GB RAM |
| App / database | Docker Compose: `node:22-alpine` app, PostgreSQL 16-alpine |
| Baseline code | `main` @ `6ee50f6` (image rebuilt before measuring) |
| Optimized code | same plus the two changes in this document |
| Load generator | autocannon 7.15.0 via `npm run loadtest` on the host |
| Rate limiter | `RATE_LIMIT_MAX=10000000` during windows only, restored afterwards |

## Method

Documented project procedure, identical on both sides:

- Account-scoped `POST /usage`, `units=1`, unique idempotency key per
  request, pipelining 1, **10 connections**, **30 s per run**, 5 s warm-up
  run discarded, **three measured runs** in sequence (all reported; none
  dropped).
- Before/after snapshots of accepted/rejected row counts and the load-test
  account counter; `verify-invariants.js` (INV-1…INV-8) after every run
  batch; workload-mode smoke runs (`--users`, `--duplicate-every`,
  `--near-quota`) on the optimized build.

## Results

| Run | Baseline RPS | Optimized RPS |
|-----|-------------:|--------------:|
| 1 | 112.57 | 124.34 |
| 2 | 121.00 | 128.60 |
| 3 | 121.14 | 123.70 |
| **Mean** | **118.24** | **125.55 (+6.2%)** |

Latency (per run, ms):

| Metric | Baseline | Optimized |
|--------|----------|-----------|
| p50 | 85 / 80 / 80 | 77 / 75 / 76 |
| p90 | 97 / 88 / 88 | 90 / 84 / 86 |
| p99 | 175 / 141 / 116 | 124 / 110 / 166 |
| mean | 88.09 / 81.87 / 81.76 | 79.67 / 77.01 / 80.10 |

- Errors / timeouts / non-2xx: **0 / 0 / 0** on every run; accepted =
  completed, 100% `decision=accepted`.
- The fastest baseline run (121.14) is below the slowest optimized run
  (123.70): the distributions do not overlap within this session.
- Accounting: whole-database accepted delta (+23,055 over the benchmark
  session) exactly matched the account-counter delta; `verify-invariants.js`
  reported all invariants hold after the runs and after the workload-mode
  smokes (final scope: 82,007 accepted / 2,072 rejected, all hold).
- Workload modes on the optimized build: `--users 10` (940 accepted, 0
  non-decision), `--duplicate-every 5` (1,171 accepted, replays not
  double-counted), `--near-quota --headroom 30` (exactly 30 accepted, 1,056
  `account_quota_exceeded`, allowance restored) — all 0 errors.

## What changed

Two small changes on the usage request path; lock order, idempotency,
evaluation, and persistence semantics unchanged:

1. **Fused assignment + plan resolution**
   (`selectCurrentPlanQuotaByAccount` / `selectCurrentPlanQuotaByUser` in
   `assignmentRepository.ts`, used by `resolveUsageContext`). The hot path
   previously ran two queries per scope — current assignment, then plan by
   id — with the same predicates and the same active/not-deleted plan
   filter, now one join. "No row" covers both no-assignment and unusable
   plan, which the usage path already treated identically (fail-closed 409).
   A user-scoped transaction drops from 14 to 12 statements; each removed
   statement saved one network round trip *and* one parse/plan cycle inside
   the serialized section of the transaction.
2. **Throttled `api_keys.last_used_at` stamp**
   (`updateApiKeyLastUsedAt`). The stamp is advisory telemetry shown on the
   key list; the UPDATE now only writes when the stored stamp is NULL or
   older than 10 s (`make_interval` against the transaction clock `now()`).
   Under sustained load this skips one tuple write + WAL record per request
   near commit. First use always stamps (the HTTP contract is "not null
   after use", covered by tests).

Supporting evidence before the change: `EXPLAIN (ANALYZE, BUFFERS)` on every
hot-path query against live data showed no sequential-scan regressions or
buffer problems at current scale (replay lookup on the partial unique index,
auth on the partial active-key index; small tables are planner-chosen seq
scans). The measured cost was per-statement overhead — round trip + plan +
small execution — which statement fusion directly reduces.

## Considered and rejected

| Candidate | Why rejected |
|-----------|--------------|
| Fold `clock_timestamp()` into the account `FOR UPDATE` statement | Documented in `accountRepository.ts`: the target list can be evaluated before the row lock is acquired, reintroducing a pre-lock admission timestamp (month-boundary invariant). |
| Multi-row single-statement counter increment | Lock acquisition order inside one joined UPDATE is not guaranteed account-then-user; weakens the fixed lock order that prevents deadlocks. |
| `synchronous_commit=off` | Loses durable commits: an acknowledged accept could vanish on crash, re-opening spent quota. Correctness beats throughput. |
| Optimistic CAS on counters | Redesign of the correctness-critical path; out of scope for small low-risk work. |
| Removing request logging | Measured earlier at ≈3–6% — inside noise — and request logs are a stated requirement. |

## Reproduction

```bash
# raise the rate limit and rebuild the image under test
RATE_LIMIT_MAX=10000000 docker compose up -d --build --wait app

export LOADTEST_API_KEY=<key from bootstrap-loadtest>
npm run loadtest -- --duration 5  --connections 10   # warm-up, discard
npm run loadtest -- --duration 30 --connections 10   # ×3, report every run

docker compose run --rm app node dist/scripts/verify-invariants.js
docker compose up -d app                             # restore rate limit 100
```

## Limitations

- One shared WSL2 machine; single 30 s runs; no confidence intervals beyond
  the three-run spread and the non-overlapping distributions shown above.
- The +6.2% is a single-account, serialized-workload result; multi-account
  scaling is bounded by CPU in this environment (measured 162 req/s combined
  for two accounts earlier the same day).
- Not re-run for every future change; re-benchmark when the hot path or the
  lock structure changes.
