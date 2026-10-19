# Extreme Capacity and Correctness Campaign — Usage Metering & Quota Service

**Date:** 2026-10-18/19 (UTC)
**Target:** `usage-metering-quota-service` (TypeScript / Node.js / Express / PostgreSQL)
**Environment:** isolated Docker Compose project `um-extreme` on a local WSL2 host
**Status:** Campaign completed; the isolated stack was torn down and its volumes retained. The development stack and development database were not modified.

---

## 1. Executive summary

The service is correct under concurrent load and is protected by its idempotency and counter design. The dominant scalability limit is the **serialized hot-account counter path**, not the HTTP layer, PostgreSQL CPU, or the database pool size. On this host:

| Area | Result |
|---|---|
| Baseline test suite | 21 files, 204 tests passed (126.3 s) against the isolated PostgreSQL |
| CLI smoke suite | 59/59 checks passed |
| Default rate limit | 100 HTTP 200 + 9,851 HTTP 429 in a 5 s burst; 0 other errors |
| Hot account, single tenant | ~121–126 rps plateau; latencies grow linearly with concurrency |
| Hot account, clean boundary | 650 connections clean (two runs); first failures at 675; severe at 800 |
| Hot account, failed requests | HTTP 500 from the 5 s pg-pool acquire timeout; nothing persisted |
| Multi-account throughput | ~181–191 rps with 8–16 accounts; app CPU is the ceiling |
| Idempotency storm | 200 concurrent identical requests → 1 committed row, 1 unit, 200 identical 200 responses |
| Idempotency conflict | 300 mixed requests → 150×200, 150×409 `CONFLICT`, 1 committed row, 1 unit |
| Account boundary race | allowance 50, 200 concurrent → exactly 50 accepted, 150 rejected, counter +50 |
| User boundary race | user allowance 10, 100 concurrent → exactly 10 accepted, 90 rejected, user counter +10 |
| 10-minute soak at 550 connections | 98.3 observed rps, 1.0% HTTP 500 (pool acquire timeouts), stable committed rate |
| Accounting invariants | all hold: 291,383 accepted / 248 rejected, 0 duplicate idempotency keys, 0 negative remainings |
| Development database | unchanged (same counts and counters as the pre-campaign baseline) |

**Headline finding:** for a single hot account, adding concurrency after ~50 connections buys almost no throughput. It only adds queueing latency, until requests begin failing at the 5 s pool-acquire timeout. The account counter row lock is held across `COMMIT`, and `synchronous_commit=on` makes those commits serial in the hot path. Measured service time was ~8 ms/commit before the mid-campaign VM restart (~125 rps) and ~10 ms/commit after it (~100 rps).

---

## 2. Environment and isolation

| Item | Value |
|---|---|
| Host | WSL2, kernel 6.18.33.2-microsoft-standard, 12 vCPU, 8.3 GiB RAM |
| Host Node / npm | v22.15.0 / 10.9.2 |
| Load tool | autocannon 7.15.0 |
| Docker / Compose | 29.8.1 / v5.5.1 |
| Application Node | v22.23.3 |
| PostgreSQL | 16.15 |
| Redis | 7.4.11 |
| PostgreSQL | `max_connections=100`, `shared_buffers=16384×8kB (128 MiB)`, `synchronous_commit=on` |
| App pool | `max=20`, `connectionTimeoutMillis=5000`, `statement_timeout=15000` |

Isolation measures:

- A campaign-only Compose file (`docker-compose.campaign.yml`) with project `um-extreme`, dedicated containers, host ports **3100/5440/6380**, and `restart: "no"`.
- Dedicated named volumes `um-extreme_pgdata_campaign` and `um-extreme_bootstrap-secrets-campaign`.
- Fixture creation required `DATABASE_URL` to point at port **5440**; there is an explicit guard in `scripts/setup-fixtures.ts`.
- The development stack (`usage-metering-app/db/redis`, port 3000) was never targeted. Its database was snapshotted before the campaign and re-checked afterwards.
- No application code, tracked migration, or tracked documentation was changed. No commit was made.
- Teardown used `docker compose ... down` **without** `-v`; the isolated volumes were retained, containers and network removed.
- The rate limiter was raised to `RATE_LIMIT_MAX=10000000` for capacity stages only. The default 100 requests/60 s behavior was characterized separately.

---

## 3. Methodology

The campaign used four scenarios:

- **A — hot-account ladder:** one account, one API key, unique idempotency keys, `units=1`, progressively more HTTP connections (1 → 800). This measures the single-hot-tenant ceiling and the failure boundary.
- **A′ — multi-user same account:** 8 separate load-generator processes against 8 users of the same account, to exercise the account+user counter lock path.
- **B — multi-account:** 8 or 16 distinct accounts, one process per account, each with 25 or 50 connections.
- **C — correctness under concurrency:** same-key storms, payload-conflict storms, rejected-decision replay, and simultaneous boundary races.
- **D — soak and recovery:** a 10-minute run just below the measured clean boundary, followed by a low-concurrency recovery benchmark and health/invariant checks.

Every capacity stage included a short 5-connection warmup unless noted. Database state (account/user counters, request counts, duplicates, negative remainings, PostgreSQL statistics) was snapshotted before and after each stage. A 2-second sampler recorded container CPU/memory, PostgreSQL active backends, lock waiters, host load, and load-generator CPU.

Important measurement properties:

- autocannon is a **closed-loop** generator. Latency includes client-side queueing; the reported connections are concurrent pending requests.
- autocannon exposes p50/p75/p90/p97_5/p99/p99_9/p99_99/p99_999, **not p95**. This report uses p97_5 where a p95-like figure is useful.
- The reported rps is the response rate (2xx + 5xx). For failing stages, the 2xx count is reported separately.
- Under saturation, autocannon stops after the duration while the server still has queued requests. Those requests may still commit after the client has stopped accounting for them. This **tail commit** effect is quantified in section 5.4; database attribution was corrected by idempotency-key prefix, not by wall-clock windows.

---

## 4. Baseline correctness

| Check | Result | Artifact |
|---|---|---|
| Full test suite (isolated DB) | 21 files / 204 tests passed, 126.30 s | `raw/baseline-test-suite.log` |
| CLI demo | 59/59 checks passed | `raw/cli-demo.log` |
| Default rate limit | 100×200, 9,851×429, 0 errors, 0 resets | `raw/rate-limit-default.json` |
| Smoke: accept + replay + conflict | 200 accepted, identical replay 200, conflicting 409 | campaign notes |

The test database was created inside the isolated PostgreSQL on port 5440. The development database was not used for tests.

---

## 5. Scenario A — single hot account

### 5.1 Ladder results

`units=1`, unique idempotency key per request, same account and API key.

| Stage | Connections | Duration | Responses | rps | p50 | p90 | p99 | max | 200 | 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| a-c1 | 1 | 30 s | 2,741 | 91.4 | 10 ms | 12 ms | 20 ms | 100 ms | 2,741 | 0 |
| a-c5 | 5 | 60 s | 8,528 | 142.1 | 15 ms | 80 ms | 173 ms | 377 ms | 8,528 | 0 |
| a-c10 | 10 | 60 s | 8,369 | 139.5 | 15 ms | 212 ms | 507 ms | 977 ms | 8,369 | 0 |
| a-c25 | 25 | 60 s | 7,424 | 123.7 | 59 ms | 539 ms | 1,214 ms | 2,340 ms | 7,424 | 0 |
| a-c50 | 50 | 60 s | 7,428 | 123.8 | 268 ms | 751 ms | 1,388 ms | 3,110 ms | 7,428 | 0 |
| a-c100 | 100 | 60 s | 7,508 | 125.1 | 672 ms | 1,152 ms | 1,827 ms | 3,350 ms | 7,508 | 0 |
| a-c200 | 200 | 60 s | 7,551 | 125.8 | 1,462 ms | 1,925 ms | 2,591 ms | 3,877 ms | 7,551 | 0 |
| a-c400 | 400 | 60 s | 7,109 | 118.5 | 3,204 ms | 3,839 ms | 4,510 ms | 6,280 ms | 7,109 | 0 |
| a-c500-sustained | 500 | 120 s | 14,696 | 122.5 | 3,966 ms | 4,424 ms | 5,125 ms | 6,932 ms | 14,696 | 0 |
| a-c500-repeat | 500 | 60 s | 7,496 | 124.9 | 3,880 ms | 4,292 ms | 4,977 ms | 6,319 ms | 7,496 | 0 |
| a-c600 | 600 | 60 s | 7,550 | 125.8 | 4,611 ms | 5,077 ms | 5,722 ms | 7,195 ms | 7,550 | 0 |
| a-c600-repeat | 600 | 60 s | 7,271 | 121.2 | 4,755 ms | 5,263 ms | 6,027 ms | 7,182 ms | 7,271 | 0 |
| a-c650 | 650 | 60 s | 7,294 | 121.6 | 5,197 ms | 5,653 ms | 6,333 ms | 8,229 ms | 7,294 | 0 |
| a-c650-repeat | 650 | 60 s | 7,451 | 124.2 | 5,107 ms | 5,547 ms | 6,178 ms | 7,946 ms | 7,451 | 0 |
| a-c675 | 675 | 60 s | 7,420 | 123.7 | 5,302 ms | 5,753 ms | 6,481 ms | 7,752 ms | 7,395 | 25 |
| a-c700 | 700 | 60 s | 7,526 | 125.4 | 5,427 ms | 5,874 ms | 6,506 ms | 8,187 ms | 7,453 | 73 |
| a-c700-repeat | 700 | 60 s | 7,547 | 125.8 | 5,383 ms | 5,825 ms | 6,468 ms | 7,435 ms | 7,238 | 309 |
| a-c800 | 800 | 60 s | 8,447 | 140.8 | 5,426 ms | 5,917 ms | 6,650 ms | 8,783 ms | 6,949 | 1,498 |

The stages were partly exploratory and the table is sorted by connection count, not chronology. In execution order, `c600` was clean, `c700` produced 73 failures, `c800` produced 1,498, `c650` was clean twice, and `c675` produced 25. The boundary is therefore **between 650 and 675 connections** before the VM restart.

### 5.2 What the numbers mean

- Throughput is essentially flat at **~121–126 rps** from 5 to 650 connections. More concurrency does not create more capacity.
- Latency grows approximately linearly with connection count: p50 ≈ connections / 125 rps, plus overhead.
- The first failures appear when the queueing delay approaches the **5,000 ms pg-pool acquire timeout**. The failure is an HTTP 500 with:

  ```
  Error: timeout exceeded when trying to connect
      at pg-pool/index.js:45
      at async withTransaction (dist/db/client.js:33)
  ```

  The sample request logged `durationMs: 5993`.
- The pool math is consistent with observation. The pool has 20 connections. If the hot path commits at `S` rps, the expected wait for the last of `C` queued requests is roughly `(C − 20) / S`. With `S ≈ 125`, the 5 s threshold is reached near `C ≈ 645`; with `S ≈ 100` (after the restart), near `C ≈ 520`. The observed clean/failing boundaries are 650/675 and 500/550 respectively.
- Failed requests do not consume quota. Database deltas confirmed that only 2xx responses (plus the tail described below) were persisted.

### 5.3 Why throughput is flat

The transaction serializes on the account counter row:

1. `resolveUsageContext` calls `upsertAndLockCounter` for the account row (`src/application/usage/resolveUsageContext.ts:55`).
2. The `INSERT ... ON CONFLICT ... DO UPDATE SET counter = usage_counters.counter RETURNING ...` acquires a row lock (`src/infrastructure/repositories/counterRepository.ts:26`).
3. The transaction then updates the counter, inserts the usage request, stamps the API key, and commits.
4. The row lock is held until `COMMIT`. With `synchronous_commit=on`, the commit waits for WAL flush. Other requests for the same account wait on the row lock before they can reach their own commit, so **group commit is defeated in the hot-account path**.

During the soak, the sampler consistently saw `pg_lock_waiters = 19` and `pg_active = 21` (20 pooled connections + sampler), while app CPU was only ~55–60% and PostgreSQL CPU ~72%. That is direct evidence that the queue is a **lock/commit queue**, not an HTTP or CPU queue.

### 5.4 Tail commits (important measurement caveat)

For every stage, the number of committed accepted rows exceeded the observed HTTP 2xx count by **exactly the number of connections** (with small deviations on stages that had failures):

| Stage | Connections | HTTP 2xx | Committed main rows | Tail |
|---|---:|---:|---:|---:|
| a-c10 | 10 | 8,369 | 8,379 | 10 |
| a-c50 | 50 | 7,428 | 7,478 | 50 |
| a-c200 | 200 | 7,551 | 7,751 | 200 |
| a-c400 | 400 | 7,109 | 7,509 | 400 |
| a-c500-sustained | 500 | 14,696 | 15,196 | 500 |
| a-c650-repeat | 650 | 7,451 | 8,101 | 650 |
| a-c800 | 800 | 6,949 | 7,615 | 666 (some aborted) |
| a-multi8x25 | 200 (25×8) | 5,465 | 5,665 | 200 |
| b-16x50 | 800 (50×16) | 11,456 | 12,256 | 800 |
| d-soak-550 | 550 | 58,398 | 58,948 | 550 |

At the end of a saturated run, one request per connection is already in the server's queue when autocannon stops. The server completes them; the client never sees the responses. **They still consume quota.** A client must retry with the same idempotency key; the replay returns the committed decision without double-consuming. This is exactly why the idempotency contract matters operationally, not only in tests. It also means a stage snapshot taken at the client's finish time can lag committed rows by up to the connection count, and the next stage's time-window delta can include the previous stage's tail. Correctness verification in this campaign used idempotency-key prefixes, not only snapshots.

### 5.5 Multi-user same account (A′)

8 separate processes, one per user of the same account:

| Stage | Connections | Responses | Aggregate rps | Per-process rps | p50 (median) | p99 (median) | 500 |
|---|---:|---:|---:|---:|---:|---:|---:|
| a-multi8x25 | 200 | 5,465 | 91.08 | 11.2–11.6 | 1,915 ms | 5,008 ms | 0 |
| a-multi8x50 | 400 | 5,758 | 95.97 | 11.65–12.3 | 3,949 ms | 5,396 ms | 0 |

User-scoped traffic is slower than account-level traffic on the same hot account (~91–96 rps vs ~125 rps) because the transaction locks the account counter and then the user counter, and both are held through commit. The user-scoped path also adds work, but the main effect is the same serialized commit queue.

---

## 6. Scenario B — multiple accounts

| Stage | Accounts | Connections | Responses | rps | Per-account rps | p50 (median) | p99 (median) | 500 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| b-8x25 | 8 | 200 | 10,845 | 180.75 | 22.3–23.0 | 1,060 ms | 2,285 ms | 0 |
| b-8x50 | 8 | 400 | 11,214 | 186.9 | 22.8–24.0 | 2,091 ms | 2,637 ms | 0 |
| b-16x25 | 16 | 400 | 10,860 | 181.0 | 11.0–11.8 | 2,010 ms | 6,383 ms | 209 |
| b-16x50 | 16 | 800 | 11,456 | 190.93 | 11.6–12.8 | 3,971 ms | 5,248 ms | 0 |

### 6.1 Steady-state resource evidence

| Metric | 8 accounts | 16 accounts |
|---|---|---|
| App CPU | ~111–116% (≈1.1 cores) | ~107–110% |
| PostgreSQL CPU | ~80–84% | ~84–94% |
| Redis CPU | ~5% | ~5% |
| PostgreSQL active backends | 8–14 | 6–14 |
| Lock waiters | 6–8 | 3–12 |
| Host load (1-min) | ~4.0 / 12 | ~3.7–4.4 / 12 |
| Load-generator CPU | ~33–42% | ~50–51% |

The ~190 rps plateau at both 8 and 16 accounts strongly indicates an **application CPU ceiling**, not a database capacity ceiling. PostgreSQL still has active-backend and lock-waiter headroom. Node.js is effectively using one core (~1.1 of 12); the rest of the host is idle.

### 6.2 Transaction amplification

During `b-16x50`, the database delta was ~11,634 accepted requests (before the tail) and ~24,272 commits: about **2.09 PostgreSQL transactions per HTTP request**. API-key verification performs its own autocommit database query in `src/infrastructure/auth/apiKeyAuthService.ts:10`, outside the usage transaction. That doubles database round trips and contributes to the app's per-request CPU cost. It is a clear optimization target (verified-key cache or folding verification into the usage transaction).

### 6.3 The b-16x25 startup transient

The 209 HTTP 500s in `b-16x25` all occurred in a two-second window at **22:55:02–22:55:03**, roughly 8 seconds after the stage started. They were distributed across all 16 accounts (2–25 per account), not concentrated in one tenant. Steady state was clean. This is a **startup transient**: 400 simultaneous connections plus the previous stage's queued tail briefly exceed the 5 s pool acquire timeout. It is not evidence of a 400-connection sustained limit. The subsequent `b-16x50` run (800 connections) had zero failures.

---

## 7. Scenario C — correctness under concurrency

### 7.1 Idempotency storms

| Test | Requests | Payload | Result | Rows for key | Units consumed |
|---|---:|---|---|---:|---:|
| Same-key storm | 200 | identical, `units=1` | 200×200 `accepted`; one distinct `accountRemaining` value | 1 | 1 |
| Conflict storm | 300 | alternating `units=1` / `units=2` | 150×200 (winner payload), 150×409 `CONFLICT` | 1 | 1 |

The same-key storm's counter moved from 0 to 1. The conflict storm's counter moved from 1 to 2 (the winner had `units=1`). The conflict responses did not create usage rows. This demonstrates winner selection, replay of the committed result, and request-hash conflict detection under genuine concurrency.

Rejected decisions are also replayable:

- Identical replay of a rejected key → HTTP 200, `decision=rejected`, `account_quota_exceeded`, `accountRemaining=0`.
- Replay of the same key with a different payload → HTTP 409 `CONFLICT`.
- The key still had exactly one committed row.

### 7.2 Boundary races

| Test | Allowance | Requests | Accepted | Rejected | Rejection reason | Counter delta | Post-exhaustion check |
|---|---:|---:|---:|---:|---|---:|---|
| Account boundary | 50 | 200 | 50 | 150 | `account_quota_exceeded` | +50 | next request rejected, remaining 0 |
| User boundary | 10 (user), 1,000,000 (account) | 100 | 10 | 90 | `user_quota_exceeded` | +10 user, +10 account | user request rejected with `userRemaining=0`; account-level request still accepted |

Both races produced exactly the allowed number of accepted requests; no overspend and no double consumption. The rejected rows were persisted with their reasons (150 and 90 respectively), while counters counted only accepted units. `minAccountRemaining`/`minUserRemaining` reported by clients reached 0, never negative.

### 7.3 Counter consistency

After the multi-user runs, every user counter equaled the number of committed accepted rows for that user, and the account counter equaled the total number of committed accepted rows for the account (`raw/c3-accounting-consistency.json`). The apparent early discrepancy was fully explained by the tail-commit effect (section 5.4); it was not an accounting defect.

---

## 8. Scenario D — soak and recovery

### 8.1 Ten-minute soak at 550 connections

| Metric | Value |
|---|---|
| Duration | 600 s |
| Connections | 550 |
| Responses | 58,991 |
| 2xx / 5xx | 58,398 / 593 (1.0%) |
| Observed rps | 98.3 |
| Committed accepted rows | 58,948 (tail 550) |
| p50 / p90 / p99 | 5,510 / 6,101 / 7,071 ms |
| Max latency | 9,884 ms |
| Steady committed rate | 5,854–6,213 per minute (~98–104 rps) |
| Failure | 5 s pg-pool acquire timeout |
| Deadlocks / statement timeouts / serialization failures | 0 / 0 / 0 |

The committed rate was flat for the whole ten minutes; there is no evidence of a slow leak or progressive degradation. The failures were bursty, not uniform:

| Minute | Pool-timeout 500s |
|---|---:|
| 23:09 | 96 |
| 23:10 | 126 |
| 23:11 | 554 |
| 23:12 | 70 |
| 23:13 | 130 |
| 23:14 | 10 |
| 23:16 | 24 |
| 23:17 | 130 |
| 23:18 | 28 |
| 23:19 | 18 |

The largest burst (554) overlaps a PostgreSQL checkpoint window that started at 23:11:27. Checkpoints are spread by configuration, but a WAL flush stall can push a batch of queued requests past the 5 s pool-acquire timeout. This is consistent with the lock/commit-queue explanation; it is not a statement timeout or a deadlock. The app log stack confirmed the failure occurs in `withTransaction` while acquiring a connection, before any usage transaction begins.

### 8.2 Recovery

After the soak, a 10-connection, 30-second run recovered to:

- 99.7 rps, p50 23 ms, p90 277 ms, p99 687 ms, 0 errors.
- A 500-connection, 60-second run was clean: 97.2 rps, p50 4,940 ms, p99 6,391 ms, 0 errors.

The system recovers immediately; the failures do not leave stuck connections, locks, or partial accounting.

### 8.3 Health and invariants after load

- `/health/live` → 200 `{ "status": "ok" }`
- `/health/ready` → 200 with database check healthy
- `verify-invariants` → exit 0: `All accounting invariants hold.`
- Final isolated DB: 21 accounts, 291,631 usage requests, 291,383 accepted, 248 rejected, 0 duplicate idempotency keys, 0 negative remainings.

---

## 9. Dev environment integrity

The development database was snapshotted before the campaign (`snapshots/dev-db-before.json`) and re-read afterwards (`snapshots/dev-db-after.json`):

| Check | Before | After |
|---|---:|---:|
| Accounts | 2 | 2 |
| Users | 54 | 54 |
| Plans | 16 | 16 |
| API keys | 9 | 9 |
| Usage requests | 28,810 | 28,810 |
| Accepted / rejected | 28,772 / 38 | 28,772 / 38 |
| Accepted units | 34,046 | 34,046 |
| Account counters | 7,727 / 26,319 | 7,727 / 26,319 |
| User counter count / sum | 50 / 1,144 | 50 / 1,144 |
| Duplicate keys / negative remainings | 0 / 0 | 0 / 0 |

No differences. The development containers remained healthy, and the dev app's liveness endpoint returned 200 after the campaign.

---

## 10. Incident: WSL2 VM restart

At **22:48 UTC** the WSL2 VM restarted mid-campaign. All containers exited with code 255.

- The development stack had `restart: unless-stopped` and came back automatically.
- The isolated campaign stack had `restart: "no"` by design and stayed down. This is the intended safety behavior: a crashed isolated stack must not spontaneously compete for the development database or ports.
- The isolated stack was restarted; PostgreSQL performed crash recovery from the last checkpoint; the accounting invariants passed immediately (176,217 accepted / 6 rejected at that point).
- The aborted `b-8x25` run (empty output, no JSON) was labeled aborted and rerun. The rerun is the `b-8x25` result in this report; its committed-row count was filtered by the rerun's start time to avoid mixing with the aborted run.
- The development database was re-checked after the restart and was unchanged.

**Performance impact:** single-hot-account throughput shifted from ~121–126 rps (clean to 650 connections) before the restart to ~97–100 rps (clean to 500 connections) after it, a ~20% reduction. Multi-account throughput remained ~180–191 rps. The precise cause was not isolated; the most plausible explanation is a change in fsync/disk behavior of the WSL2 virtual disk after restart, which directly affects the serialized commit path. This must be treated as **environment variance**, not as a code regression. The correctness invariants were unaffected.

---

## 11. Bottleneck synthesis

### Hot account

```
N concurrent HTTP requests
        │
        ▼
   Node/Express (CPU ~55–60%)  ── auth query (1 autocommit transaction)
        │
        ▼
   pg pool (20 connections, 5 s acquire timeout)
        │
        ▼
   BEGIN
   lock account counter row  ◄── only one transaction progresses
   lock user counter row        (if user-scoped)
   update counters
   insert usage_request
   stamp API key
   COMMIT  ── synchronous_commit=on → serialized WAL flush
        │
        ▼
   next waiter
```

- Service rate is set by the serialized transaction time, not by concurrency.
- Adding connections increases the number of waiters, and therefore latency, until the 5 s pool-acquire timeout.
- Raising the pool size would not raise hot-account throughput; it would only put more connections in the lock queue.
- The 15 s `statement_timeout` was never reached; the 5 s pool acquire timeout fired first.

### Multi-account

- Different accounts lock different counter rows, so commits can proceed in parallel and group commit works.
- Throughput rises to ~190 rps, at which point the **Node.js event loop** (~1.1 cores) is the ceiling.
- PostgreSQL still has headroom (6–14 active backends, 3–12 lock waiters).
- The API-key query doubles database transactions per request and contributes to the app CPU ceiling.

### Latency/capacity guidance (hot account, measured)

| Connections | p99 (pre-restart) | Practical interpretation |
|---:|---:|---|
| 10 | 0.51 s | interactive |
| 25 | 1.21 s | near interactive |
| 50 | 1.39 s | background / batch |
| 100 | 1.83 s | background |
| 200 | 2.59 s | batch |
| 400 | 4.51 s | batch, at risk |
| 500 | 5.13 s | edge; post-restart p99 6.39 s |
| 550+ | — | pool timeouts appear after the restart |
| 650 | 6.33 s | pre-restart clean edge |
| 675+ | 6.48 s+ | failures begin |

The success rate is flat; the cost of concurrency is entirely latency and, eventually, pool-acquire failures.

---

## 12. Recommendations

Ordered by expected impact on the actual bottleneck:

1. **Shorten the hot-account critical section.** Replace the `upsertAndLockCounter` + separate counter updates + insert with a single atomic statement/CTE where possible, or at least reduce round trips inside the transaction. The row lock must be held for less time.
2. **Remove the per-request authentication query.** Cache verified API keys for a short TTL, or fold verification into the usage transaction. This should roughly halve PostgreSQL transactions per request and reduce both pool contention and app CPU.
3. **Return an overload response instead of HTTP 500 on pool exhaustion.** A 5 s pool-acquire timeout is an overload condition, not an internal bug. Use 503 (or 429 with `Retry-After`) and a stable error code, and emit a metric.
4. **Do not solve hot-account latency with a larger pool.** Size the pool against the latency SLO and use admission control. More pooled connections merely increase lock waiters and timeout risk.
5. **Expose `pg_lock_waiters` and p99 as first-class production metrics.** They are the leading indicators of hot-account saturation.
6. **Plan multi-account scale around the Node CPU ceiling.** Profile the event loop; consider clustering/worker threads or multiple app instances. A single hot account remains serialized by PostgreSQL regardless of app instance count.
7. **Re-baseline on the target disk before publishing capacity.** The post-restart ~20% shift shows that the hot-account ceiling is sensitive to fsync/disk behavior. Capacity numbers should be tied to a specific deployment environment.

---

## 13. Limitations and honest disclosures

- Single WSL2 host; the load generator, application, and database share 12 vCPUs. These are not production cloud capacity numbers.
- The VM restarted mid-campaign. Pre/post-restart single-account capacity differs by ~20%; the cause was not proven.
- The rate limiter was intentionally raised for capacity stages. The default 100/60 s limit was verified separately and produces 429s, not 500s.
- autocannon is closed-loop and reports p97_5, not p95. Latencies include client-side queueing.
- One request per connection (pipelining=1); no HTTP pipelining, TLS termination, reverse proxy, or mixed read/write workload was tested.
- Container log rotation discarded older error entries. Stage JSON files are authoritative for 500 counts; the retained log audit covers the late ladder, `b-16x25`, and the soak.
- The 10-minute soak is a stability check, not a multi-hour leak test. Longer runs may expose slow leaks or autovacuum/checkpoint interactions.
- No month-rollover, failover, disk-full, Redis-outage, or process-kill chaos tests were performed during this campaign. Those behaviors are covered by the existing test suite only to the extent documented there.
- Raw artifacts contain ephemeral isolated test API keys and account identifiers. The stack is torn down, but the artifacts must not be published without redaction.
- No application code, migration, or tracked documentation was modified. No commit was created.

---

## 14. Reproduction

The campaign tooling is in `scripts/` and is campaign-only (untracked). Typical flow:

```bash
# 1. Start the isolated stack (dedicated project and ports)
docker compose -f docker-compose.campaign.yml -p um-extreme up -d --build

# 2. Create a test database inside the isolated PostgreSQL and run the suite
#    (never point TEST_DATABASE_URL at the development database)
TEST_DATABASE_URL=postgresql://app:app_secret@localhost:5440/usage_metering_test \
  npm test

# 3. Create fixtures (the script requires port 5440)
DATABASE_URL=postgresql://app:app_secret@localhost:5440/usage_metering \
  npx tsx scripts/setup-fixtures.ts --config scripts/fixtures.json \
  --out snapshots/fixtures-output.json

# 4. Run a stage (keys are ephemeral, isolated test credentials)
source snapshots/keys.env
./scripts/stage.sh a-c100 100 60 "$KEY_EXTREME_HOT"

# 5. Multi-account
./scripts/multi-stage.sh b-8x25 25 60 \
  "$KEY_EXTREME_B00,$KEY_EXTREME_B01,$KEY_EXTREME_B02,$KEY_EXTREME_B03,$KEY_EXTREME_B04,$KEY_EXTREME_B05,$KEY_EXTREME_B06,$KEY_EXTREME_B07"

# 6. Correctness probes
node scripts/probe-idempotency.mjs http://localhost:3100 "$KEY_EXTREME_IDEM" same 200 1
node scripts/probe-burst.mjs http://localhost:3100 "$KEY_EXTREME_BOUNDARY_A" 200 1

# 7. Verify and tear down (keep volumes)
docker exec um-extreme-app node dist/scripts/verify-invariants.js
docker compose -f docker-compose.campaign.yml -p um-extreme down
```

Keys in `snapshots/keys.env` and `snapshots/fixtures-output.json` are disposable isolated-stack credentials. They are not development or production secrets, but they should still be redacted before sharing the artifacts.

---

## 15. Artifact index

| Path | Contents |
|---|---|
| `REPORT.md` | This report |
| `summary.json` | Machine-readable campaign summary |
| `docker-compose.campaign.yml` | Isolated campaign stack |
| `scripts/run-stage.mjs` | Single-target autocannon harness |
| `scripts/run-multi.mjs` | Multi-account parallel harness |
| `scripts/stage.sh`, `multi-stage.sh` | Stage wrappers with warmup and DB snapshots |
| `scripts/probe-idempotency.mjs` | Same-key / conflict storm probe |
| `scripts/probe-burst.mjs` | Concurrent quota-boundary probe |
| `scripts/sampler.mjs` | 2-second resource sampler |
| `scripts/db-state.mjs` | Read-only DB state snapshot |
| `scripts/setup-fixtures.ts` | Isolated fixture creation (port-5440 guard) |
| `raw/a-*.json`, `raw/b-*.json`, `raw/d-*.json` | Per-stage autocannon results |
| `raw/c1-*.json`, `raw/c2-*.json`, `raw/c4-*.json`, `raw/c5-*.json` | Correctness probe results |
| `raw/c3-accounting-consistency.json` | Counter-vs-rows verification |
| `raw/stage-committed-counts.json` | Key-prefix committed-row attribution and tails |
| `raw/baseline-test-suite.log`, `raw/cli-demo.log` | Baseline evidence |
| `raw/soak-error-sample.log`, `raw/pg-checkpoints.log` | Failure and checkpoint evidence |
| `snapshots/versions-and-config.txt` | Environment/version/config snapshot |
| `snapshots/resources.csv`, `snapshots/resource-summary.json` | Resource time series and per-stage summaries |
| `snapshots/state-*.json` | DB state before/after stages, plus final state |
| `snapshots/fixtures-output.json`, `snapshots/keys.env` | Ephemeral isolated fixtures (redact before sharing) |
| `snapshots/invariants-after-vm-restart.log`, `snapshots/invariants-final.log` | Invariant checks |
| `snapshots/dev-db-before.json`, `snapshots/dev-db-after.json` | Development DB integrity evidence |
| `snapshots/soak-error-timing.txt`, `snapshots/b16x25-error-timing.txt` | Error timing distributions |
| `snapshots/app-error-tally.txt` | Retained app log error tally |
| `snapshots/teardown.log`, `snapshots/compose-ps-final.txt` | Teardown evidence |

---

## 16. Final verdict

- **Correctness:** strong. Idempotency replay and conflict detection hold under concurrent storms; boundary races never overspend; counters match committed rows; invariants survive a VM crash and a 10-minute soak; failed requests never consume quota.
- **Hot-account capacity:** limited to ~100–125 rps on this host, with a clean concurrency boundary of ~500–650 connections. The limit is the serialized account-counter commit path, not HTTP, CPU, or pool size.
- **Multi-account capacity:** ~190 rps on this host, limited by the single Node.js event loop; PostgreSQL still has headroom.
- **Operational behavior above the boundary:** requests fail with HTTP 500 after a 5 s pool acquire timeout. This should be turned into an explicit overload response and monitored.
- **Main engineering lever:** shorten the hot-account transaction (and remove the extra auth query). The current design is correct; it is not horizontally scalable for a single hot tenant.
