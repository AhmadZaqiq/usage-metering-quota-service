# Requirements Coverage

Maps every requirement from the project mission (AGENTS.md §2) and the
usage/quota invariants (AGENTS.md §8) to the code that implements it and the
tests that prove it. Status reflects the last full `npm run verify:all` run:
**21 test files, 223 tests, all passing**, plus the accounting-invariant
verifier (INV-1…INV-8) exiting 0 against the development database.

Status legend: **Covered** — requirement is implemented and has at least one
automated test that would fail if the behavior regressed.

## 1. Authentication and tenant isolation

| Requirement | Implementation | Tests | Status |
|---|---|---|---|
| Tenants authenticate with API keys (secret never stored) | `src/presentation/middleware/authMiddleware.ts`, `src/application/auth/apiKeyService.ts`, `src/domain/hash.ts` | `httpAuth.test.ts` (valid/missing/wrong/revoked keys, end-to-end usage) | Covered |
| Tenant context derives from the credential, never a client-supplied account id | `authMiddleware` sets `req.account` from the key lookup | `httpAuth.test.ts`, `httpScenarios.test.ts` (cross-account plan/user → 404/403) | Covered |
| Data and operations are isolated per account | Account scoping in every repository query; composite tenant foreign keys; `uq_users_account_client_user` scoped by account | `httpAuth.test.ts` (history isolation), `httpScenarios.test.ts` (foreign user → 404), `boundary.test.ts` (per-account history), **F-ISO-1** (same `clientUserId` in two accounts resolves independently) | Covered |
| Revoked keys and inactive/deleted accounts fail consistently | `authMiddleware` revocation check, fail-closed service guards | `httpAuth.test.ts`, `boundary.test.ts` §revocation | Covered |

## 2. Plans and assignments

| Requirement | Implementation | Tests | Status |
|---|---|---|---|
| System plan catalog seeded idempotently, read-only for every tenant | `src/scripts/bootstrap.ts` (`ensureSystemPlans`, exact values 10000/100 · 1000000/1000 · 500/20 · 5000/200), `planService` owner check | `bootstrap.test.ts` (exact values, idempotent re-run, 403 on system-plan mutation) | Covered |
| Account-owned custom plans (CRUD) | `src/application/plans/planService.ts`, `planRoutes.ts` | `httpScenarios.test.ts` (full plan lifecycle), `boundary.test.ts` | Covered |
| Assignments with effective dates and overlap/half-open-interval rules | `src/application/plans/assignmentService.ts`, `plan_assignments` constraints | `assignmentPolicy.test.ts`, `httpScenarios.test.ts`, `boundary.test.ts` (immediate upgrade/downgrade, superseding pending rows) | Covered |
| Assignment history preserved (rows never deleted) | `plan_assignments` close-at-successor semantics | `assignmentPolicy.test.ts`, `boundary.test.ts` | Covered |
| Default assignment for fresh accounts (Starter) | `bootstrap.ts` `ensureDefaultAssignment` | `bootstrap.test.ts` | Covered |

## 3. Usage and quota

| Requirement | Implementation | Tests | Status |
|---|---|---|---|
| Account-level and user-level monthly allowances evaluated together | Pure `src/domain/quotaEvaluator.ts` | `quotaEvaluator.test.ts` (pure unit tests, bigint boundaries) | Covered |
| Deterministic accept/reject with documented reasons | `quotaEvaluator`, `usageService` mapping | `boundary.test.ts`, `httpScenarios.test.ts` (each rejection reason over HTTP) | Covered |
| Fail-closed plan requirements (no account-only fallback for user-scoped input) | `resolveUsageContext` throws 409 | `boundary.test.ts` §BR-01 | Covered |
| Per-request cap with reported `limitScope` | `quotaEvaluator`, `usageService.toLiveDecision`, not persisted | `httpScenarios.test.ts` (live vs replayed `limitScope`), `boundary.test.ts` | Covered |
| Rejected requests never consume quota but stay auditable | `persistUsageDecision` writes the row without counter increments | `boundary.test.ts`, `httpScenarios.test.ts` (history keeps rejected rows), `verify-invariants` INV-8 | Covered |
| UTC monthly periods consistent for the whole request | Post-lock admission clock: `lockAccountForAdmission` → `readClockTimestamp` → one timestamp for `periodStart` and `created_at` (`usageService.ts`) | `monthBoundary.test.ts` (sequential, lock-wait-across-boundary, concurrent pair, replay, clock source), `verify-invariants` INV-5 | Covered |
| Allowance changes apply immediately; counters never reset; clamp at zero | Plan PATCH semantics in `planService` + evaluator clamping | `boundary.test.ts` (upgrade/downgrade preserve counters, clamped remainings) | Covered |

## 4. Idempotency and concurrency

| Requirement | Implementation | Tests | Status |
|---|---|---|---|
| Repeated request with same key and identical input returns the original committed result | `(account_id, idempotency_key)` unique index + SHA-256 request hash (`src/domain/idempotency.ts`), `replayUsageRequest.ts` | `concurrency.test.ts`, `httpScenarios.test.ts` (replay over HTTP), `boundary.test.ts` | Covered |
| Same key with different semantic input (units **or userId**) → 409 | Hash mismatch → `ConflictError` before evaluation; fingerprint in `src/domain/idempotency.ts` | `hash.test.ts` (fingerprint/hash unit tests), `httpScenarios.test.ts` (different units; **F-IDEM-1** different user) | Covered |
| Account and user counters cannot be overspent by concurrent requests | Transaction + row locks (`accounts` admission lock → account counter → user counter → api key) | `concurrency.test.ts` (parallel exhaustion), `monthBoundary.test.ts` (lock serialization) | Covered |
| Counter creation is safe under a race | `INSERT … ON CONFLICT DO UPDATE` in `counterRepository.ts` | `concurrency.test.ts`, `dbConstraints.test.ts` | Covered |
| Failed transaction leaves no partial consumption | Explicit transaction boundary in `usageService` | `rollback.test.ts` (forced failure before/after insert → full rollback) | Covered |
| Month-boundary requests are charged to the month they are admitted in | Lock-then-clock ordering; no pre-lock clock window | `monthBoundary.test.ts` (F-UTC-1 regression suite) | Covered |

## 5. Data integrity (database as source of truth)

| Requirement | Implementation | Tests | Status |
|---|---|---|---|
| Primary/foreign keys, CHECKs, unique and exclusion constraints encode invariants | `src/db/schema/*`, migrations in `src/db/migrations`, custom SQL in `src/db/sql` | `dbConstraints.test.ts`, `boundary.test.ts` (direct-SQL proofs), `rollback.test.ts` | Covered |
| Clean database migrates from scratch; migrations forward-only and idempotent | Drizzle journal + advisory-locked runner (`src/db/migrate.ts`), custom SQL applied by test setup | `setup.ts` (migrates from scratch each run), compose entrypoint runs migrations on start | Covered |
| Runtime cross-check of counters vs decision log | `src/scripts/verify-invariants.ts` (INV-1…INV-8) | `verifyInvariants.test.ts`, `npm run verify:all` | Covered |
| Native `bigint` arithmetic; JSON serializes counters as strings | Schema `mode: "bigint"`, `.toString()` at boundaries | `quotaEvaluator.test.ts`, `httpScenarios.test.ts` (string counters), `boundary.test.ts` | Covered |

## 6. API contract and operations

| Requirement | Implementation | Tests | Status |
|---|---|---|---|
| `requestId` canonical in request body and history; `idempotencyKey` accepted as deprecated alias; both → 400 | `src/validation/schemas.ts` (superRefine + transform), history DTO `requestId` (storage column unchanged) | `httpValidation.test.ts` (canonical/alias/both/neither/history shape) | Covered |
| Consistent error shapes and stable codes; status codes match the contract | `src/errors/AppError.ts`, `errorHandler.ts` | `httpStatus.test.ts`, `httpValidation.test.ts`, `httpScenarios.test.ts` | Covered |
| Input validated at the boundary; oversized/malformed payloads mapped (400/413) | Zod schemas, express json limits | `httpValidation.test.ts` | Covered |
| Structured logging with correlation, never logging secrets | `src/logging/logger.ts` (Pino), auth middleware redaction | `logger.test.ts` | Covered |
| Health/readiness endpoints and operational failure handling | `src/presentation/routes/healthRoutes.ts` | `healthFailure.test.ts` | Covered |
| Rate limiting with documented headers/status | `src/infrastructure/rateLimiter.ts` | `rateLimiter.test.ts`, `httpRateLimit.test.ts` | Covered |
| OpenAPI 3.1 + Swagger UI kept in sync with mounted routes | `src/docs/openapi.ts` | `docs.test.ts` (drift fails the suite) | Covered |
| `GET /usage` pagination + account-scoped `userId` filter (404 unknown) | `usageRoutes.ts`, `usageHistoryService.ts`, `usageRequestRepository.ts` | `httpScenarios.test.ts` (filter, 404, F-ISO-1), `httpValidation.test.ts` (pagination bounds) | Covered |
| Environment validated at startup (Zod), no implicit defaults for critical settings | `src/config/index.ts` | `config.test.ts` | Covered |

## 7. Deliverables and workflows

| Requirement | Implementation | Evidence |
|---|---|---|
| Runs locally with Docker and documented setup | `docker-compose.yml`, `Dockerfile`, `docker-entrypoint.sh` | README Quickstart; plain `up` unchanged |
| Test suite runnable inside Docker | Profile-gated `tests` service (build-stage image → `postgres-test`) | `docker compose --profile tests run --rm tests` → 21 files / 223 tests |
| Disposable app stack for smoke tests | `app-test` profile (port 3001, own database container, no named volumes) | `/health/ready` → 200 |
| Reproducible load-test script | `src/scripts/loadtest.ts` (localhost-only guard), `loadtest` profile (host networking → `localhost:3001`), perf evidence under `docs/performance/` | Profile run exit 0, 0 errors, all 2xx |
| Example client with demo + per-operation commands | `src/scripts/client.ts` (`demo` default, `consume`, `usage`, `history`; legacy `-n`/`-i` map through) | Demo: 57/57 checks, prints `All demo assertions passed.`; with `DATABASE_URL` also prints `All accounting invariants passed.` |
| One-command verification | `npm run verify` (typecheck+lint+build+tests), `npm run verify:all` (adds invariant verifier) | Both exit 0 |
| Complete README | `README.md` (+ `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, this file) | Reviewed against the implementation |

## 8. Runtime invariant verifier

`npm run verify:invariants` (or `verify:all`) checks, against a live database:

- **INV-1** account counter = Σ accepted units per account/period
- **INV-2** user counter = Σ accepted units per user/period
- **INV-3** Σ user counters ≤ account counter
- **INV-4** stored remainings are never negative
- **INV-5** `period_start` = UTC month of `created_at` (requests and counters) —
  rows written before the F-UTC-1 fix or imported from elsewhere may violate
  this; see the caveat comment in `verify-invariants.ts`
- **INV-6** tenant pairing (user-scoped rows belong to the row's account)
- **INV-7** no duplicate `(account_id, idempotency_key)`
- **INV-8** rejected requests contribute zero to counters (follows from INV-1/INV-2)

## Known limitations

Documented rather than silently implied; see the referenced sections:

- Mixed clock domains (process `Date.now()` in non-admission paths vs the
  database admission clock) — documented in `docs/ARCHITECTURE.md`; only the
  admission path is invariant-relevant (INV-5).
- INV-5 can report pre-fix/imported rows — inspect before treating a report as
  corruption (`src/scripts/verify-invariants.ts` header comment).
- Historical test-typecheck gaps: a handful of pre-existing errors appear only
  under an ad-hoc test-inclusive `tsc` run (the project typecheck excludes
  `*.test.ts` by configuration); they are tracked but do not affect
  `npm run verify`.
