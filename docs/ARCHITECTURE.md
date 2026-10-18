# Architecture Documentation

## Overview

This document describes the actual implementation architecture of the Usage Metering & Quota Service. It reflects the code as written, not an idealized design.

---

## Layer Structure

The project is organized into five explicit architectural layers with a clear dependency direction:

```
HTTP Request
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER                                          │
│  src/presentation/                                            │
│  • routes/        Express route handlers (HTTP in/out)       │
│  • middleware/    authMiddleware, asyncHandler               │
└──────────────────────────┬──────────────────────────────────┘
                           │ calls
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  APPLICATION LAYER                                           │
│  src/application/                                             │
│  • auth/         apiKeyService                               │
│  • plans/        planService, assignmentService,             │
│                  assignmentHistoryService                    │
│  • usage/        usageService (orchestrator),                 │
│                  resolveUsageContext,                         │
│                  replayUsageRequest,                          │
│                  persistUsageDecision,                        │
│                  usageHistoryService                          │
│  • users/        userService                                 │
│  • health/       healthService                               │
└──────────────────────────┬──────────────────────────────────┘
                           │ calls
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  DOMAIN LAYER (pure business rules)                          │
│  src/domain/                                                  │
│  • quotaEvaluator.ts   pure quota decision function           │
│  • idempotency.ts      request hash computation               │
│  • date.ts             UTC month start utilities              │
│  • hash.ts             cryptographic helpers                  │
│  • pgError.ts          PostgreSQL error code detection        │
└──────────────────────────┬──────────────────────────────────┘
                           │ calls
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  INFRASTRUCTURE LAYER                                         │
│  src/infrastructure/                                           │
│  • repositories/   data access (Drizzle + raw SQL)           │
│  • auth/           API key verification (repo + crypto)      │
│  • rateLimiter.ts  Redis-backed rate limiting (memory fallback)            │
└──────────────────────────┬──────────────────────────────────┘
                           │ calls
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  DATABASE INFRASTRUCTURE                                      │
│  src/db/                                                      │
│  • client.ts       connection pool, Drizzle client,           │
│                    transactions with retry                    │
│  • schema/         Drizzle table definitions                  │
│  • migrations/     Drizzle-generated migrations               │
│  • sql/            custom SQL constraints, triggers           │
│  • migrate.ts      migration runner                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
                    PostgreSQL 16
```

### Cross-Cutting Concerns (no layer dependency)

| Concern | Location |
|---------|----------|
| Configuration | `src/config/index.ts` (Zod-validated env) |
| Logging | `src/logging/logger.ts` (Pino with request correlation) |
| Error types | `src/errors/AppError.ts` |
| Error-to-HTTP mapping | `src/errors/errorHandler.ts` (Express middleware) |
| Input validation | `src/validation/schemas.ts` (Zod schemas) |
| App composition | `src/app.ts` (Express app factory) |
| Entry point | `src/main.ts` (server lifecycle, graceful shutdown) |

---

## Dependency Direction

```
Presentation → Application → Domain → Infrastructure → Database
                              ↑
                    Cross-cutting (config, logging, errors,
                    validation) used by all layers as needed
```

**Rules:**
- Presentation depends on Application + Infrastructure (rate limiter, auth)
- Application depends on Domain + Infrastructure (repositories)
- Domain depends on nothing (pure functions)
- Infrastructure depends on Database (Drizzle client, pool)
- Cross-cutting concerns are imported by any layer that needs them

No circular dependencies are permitted.

---

## Module Responsibilities

### Presentation (`src/presentation/`)
- **Routes**: HTTP request parsing, response serialization, status code mapping
- **Middleware**: Authentication (API key verification), async error wrapping
- **Must not**: Contain business logic, SQL queries, or quota algorithms

### Application (`src/application/`)
- **Services**: Use case orchestration, transaction boundaries, business rules
- **Must not**: Contain raw SQL, Express request/response handling, or HTTP serialization

### Domain (`src/domain/`)
- **Pure functions**: `quotaEvaluator`, `idempotency`, `date`, `hash`
- **Must not**: Import Express, Drizzle, PostgreSQL clients, or HTTP response objects
- **Testable**: Independently testable with bigint inputs, deterministic for identical inputs

### Infrastructure (`src/infrastructure/`)
- **Repositories**: All Drizzle queries, raw SQL, locking, row mapping
- **Auth infrastructure**: API key verification (hash + repository lookup)
- **Rate limiting**: Two layers (per-IP pre-auth, per-API-key post-auth) over a Redis store with in-process fallback and fail-closed behavior
- **Must not**: Contain business workflow rules or HTTP handling

### Database (`src/db/`)
- Connection pool, Drizzle client, transaction helper with retry logic
- Schema definitions, migrations, custom SQL
- Database lifecycle and health checks

---

## Request Flow

```
POST /usage
    │
    ▼
Presentation: IP rate limiter (pre-auth, keyed by client IP)
    │
    ▼
Presentation: Auth Middleware
    │  ├─ Extract Bearer token
    │  ├─ Verify API key (infrastructure: repo + hash, timing-safe)
    │  └─ Attach req.account { id }, req.apiKeyId
    ▼
Presentation: Identity rate limiter (post-auth, keyed by API key id)
    │
    ▼
Presentation: Zod Validation (usageRequestSchema)
    │
    ▼
Application: usageService.processUsageRequest()  (orchestrator)
    │  ├─ withTransaction (retry on deadlock/serialization failure)
    │  ├─ resolveUserId (resolveUsageContext.ts: repository: userRepository)
    │  ├─ findReplayDecision (replayUsageRequest.ts: repository: usageRequestRepository)
    │  ├─ If exists + same hash → return original decision
    │  ├─ If exists + different hash → throw ConflictError
    │  ├─ resolveUsageContext (resolveUsageContext.ts)
    │  │    ├─ Upsert + lock account counter (repository: counterRepository)
    │  │    ├─ Upsert + lock user counter if applicable
    │  │    ├─ Resolve current plans (repository: assignmentRepository)
    │  │    └─ Fail closed: missing account/user plan → ConflictError (409)
    │  ├─ quotaEvaluator.evaluateQuota() (domain: pure function)
    │  ├─ persistUsageDecision (persistUsageDecision.ts)
    │  │    ├─ Insert usage_requests ON CONFLICT DO NOTHING (repository: usageRequestRepository)
    │  │    ├─ If accepted: increment counters (repository: counterRepository)
    │  │    └─ Update API key lastUsedAt (repository: apiKeyRepository)
    │  ├─ If insert lost a concurrent race → findReplayDecision (converge on winner)
    │  └─ Return QuotaDecision
    ▼
Presentation: HTTP Response (200 accepted/rejected, 409 conflict, etc.)
```

---

## Database Schema

**Tables:**
| Table | Key Constraints |
|-------|-----------------|
| `accounts` | PK `id`, soft delete `deleted_at`, partial unique live `name` |
| `users` | PK `id`, unique `(account_id, client_user_id)`, unique `(account_id, id)` (FK companion), FK `account_id` |
| `plans` | PK `id`, check `type IN ('account','user')`, partial unique indexes ignoring soft-deleted rows |
| `plan_assignments` | PK `id`, partial unique current assignments, two partial exclusion constraints, range CHECK, plan-type trigger, composite tenant FK |
| `usage_counters` | PK `id`, partial unique per period (user NULL / not NULL), `CHECK (counter >= 0)`, composite tenant FK |
| `usage_requests` | PK `id`, unique `(account_id, idempotency_key)`, hash + decision checks, composite tenant FK |
| `api_keys` | PK `id`, unique `prefix`, hash, revocation flags |

**Custom SQL Migrations (`src/db/sql/`):**
- `btree_gist` extension
- Check constraints (plan type, positive values, non-negative counters, `chk_assignment_range`)
- Partial unique indexes (system/custom plans, current assignments, counters, live account names)
- Two partial exclusion constraints on `plan_assignments` (`no_overlap_account_assignments`, `no_overlap_user_assignments`)
- Composite tenant FKs `(account_id, user_id) → users(account_id, id)` on `usage_counters`, `usage_requests`, `plan_assignments`
- Trigger for plan-type compatibility (account plan ↔ account assignment)

---

## Important Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Tenant isolation | All queries scoped by `account_id` from authenticated API key |
| No quota over-consumption | `SELECT FOR UPDATE` on counters + atomic increment within transaction |
| Idempotency | Unique constraint on `(account_id, idempotency_key)` + request hash comparison |
| Plan-type match | PostgreSQL trigger on `plan_assignments` |
| No overlapping assignments | Two partial exclusion constraints on `tstzrange` |
| User belongs to account | Composite FK `(account_id, user_id) → users(account_id, id)` on usage_counters, usage_requests, plan_assignments |
| Fail-closed plan requirements | `usageService` throws `ConflictError` (409) when an account/user plan is missing — no account-only fallback for user-scoped input |
| Counters never negative | `CHECK (counter >= 0)` + atomic updates; evaluator clamps remaining at 0 when an allowance drops below usage |
| Positive units | `CHECK (units > 0)` in DB + Zod validation |
| Monthly UTC periods | Computed once per request via `domain/date.ts` |
| Counters equal accepted usage | `src/scripts/verify-invariants.ts` cross-checks `usage_counters` against the `usage_requests` decision log (INV-1..INV-8) and exits non-zero on mismatch |

---

## Concurrency Scenarios Handled

| Scenario | Protection |
|----------|------------|
| Concurrent same idempotency key | Unique constraint serializes; second sees existing record |
| Concurrent different keys, last units | Counter lock serializes; exactly N accepted for N remaining |
| Concurrent first counter creation | Atomic upsert creates once; both get locked row |
| Deadlock | Retry with backoff (3×) on `40P01` / `40001`, logged per retry |
| Month boundary crossing | Period computed once before transaction |
| Assign vs plan delete/deactivate | Plan row locked `FOR UPDATE`; waiter re-checks `deleted_at`/`is_active` (EvalPlanQual) and fails instead of using a stale row |
| Concurrent plan changes to the same subject | Subject assignment rows locked `FOR UPDATE` + exclusion constraints; a later change closes/supersedes earlier rows; exactly one open-ended current row survives |
| Lock wait backdating `effectiveFrom` | Clock re-read after locks acquired before stamping (BR-13) |
| Cross-account user pairing | Composite tenant FKs reject mismatched `(account_id, user_id)` (23503) |

---

## Known Limitations

1. **Rate Limiter**: Redis-backed when `REDIS_URL` is configured, else in-process; if both stores fail at runtime the limiter fails **closed** (429). Counters are per-instance without Redis
2. **Idempotency Key Retention**: Indefinite; no TTL or archival
3. **No Distributed Tracing**: Single-instance observability only
4. **Horizontal Scaling**: Single app instance; rate limiter state not shared without Redis
5. **`int8` parsing (audit DB-08)**: BigInt coercion is localized to repository mapping boundaries instead of a global `pg` type parser (deferred, see README "Known Limitations & Deferred Findings")

---

## Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Layered directory structure | Makes responsibility and dependency direction obvious at a glance |
| Pure domain functions | `quotaEvaluator` is testable without DB; deterministic for identical inputs |
| `bigint` for all quota values | Matches PostgreSQL `BIGINT`; no precision loss |
| `NULL` user_id for account counters | Avoids partial unique index ORM limitations; simpler upsert |
| SHA-256 for API keys | High-entropy secrets don't need KDF; fast verification |
| `READ COMMITTED` + explicit locks | Simpler than `SERIALIZABLE`; explicit locks are auditable |
| Immediate plan-change timing | Plan switches apply to the next request; the current row is closed at the replacement's start (half-open chain) and pending rows are superseded. Counters are never reset; lowering an allowance below usage clamps remaining to 0. Rationale: matches the required client-facing contract and keeps one mental model for upgrades and downgrades |
| Idempotency in `usage_requests` | No separate table; atomic with decision persistence |
| Fail-closed plan checks (409) | Missing plan configuration must never silently relax quota policy |
| Usage use case split into focused modules | `usageService` orchestrates; `resolveUsageContext` (user + counter locks + plans), `replayUsageRequest` (idempotent replay/conflict), and `persistUsageDecision` (decision insert + counters + last-used) each own one phase. Keeps the transaction body readable without adding classes or changing the request flow |
| `withTransaction` plain function (no TransactionRunner class) | Transaction execution (retry on 40P01/40001, rollback) is already separated from business code, which receives `tx` and threads it through every repository call. A runner class would add indirection without a concrete testability gain — integration tests exercise real PostgreSQL transactions, not mocks |

---

## Adding New Features

| What | Where | How |
|------|-------|-----|
| New HTTP endpoint | `src/presentation/routes/` | Add route file, wire into `src/app.ts` |
| New business rule/use case | `src/application/` | Create service, coordinate repositories |
| New pure calculation | `src/domain/` | Add pure function, test independently |
| New database query | `src/infrastructure/repositories/` | Add repository function with Drizzle/raw SQL |
| New validation schema | `src/validation/schemas.ts` | Add Zod schema, use in route |
| New test | `src/test/` | Unit tests for domain; integration tests with real PostgreSQL |
