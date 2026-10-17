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
│  • usage/        usageService, usageHistoryService           │
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
│  • rateLimiter.ts  in-memory + Redis rate limiting            │
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
- **Rate limiting**: In-memory + Redis implementations behind a common interface
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
Presentation: Rate Limiter middleware (per key prefix / IP)
    │
    ▼
Presentation: Auth Middleware
    │  ├─ Extract Bearer token
    │  ├─ Verify API key (infrastructure: repo + hash)
    │  └─ Attach req.account { id }, req.apiKeyId
    ▼
Presentation: Zod Validation (usageRequestSchema)
    │
    ▼
Application: usageService.processUsageRequest()
    │  ├─ withTransaction (retry on deadlock/serialization failure)
    │  ├─ Resolve user (repository: userRepository)
    │  ├─ Check idempotency key (repository: usageRequestRepository)
    │  ├─ If exists + same hash → return original decision
    │  ├─ If exists + different hash → throw ConflictError
    │  ├─ Upsert + lock account counter (repository: counterRepository)
    │  ├─ Upsert + lock user counter if applicable
    │  ├─ Resolve current plans (repository: assignmentRepository + planRepository)
    │  ├─ quotaEvaluator.evaluateQuota() (domain: pure function)
    │  ├─ Insert usage_requests with final decision (repository: usageRequestRepository)
    │  ├─ If accepted: increment counters (repository: counterRepository)
    │  ├─ Update API key lastUsedAt (repository: apiKeyRepository)
    │  └─ Return QuotaDecision
    ▼
Presentation: HTTP Response (200 accepted/rejected, 409 conflict, etc.)
```

---

## Database Schema

**Tables:**
| Table | Key Constraints |
|-------|-----------------|
| `accounts` | PK `id`, soft delete `deleted_at` |
| `users` | PK `id`, unique `(account_id, client_user_id)`, FK `account_id` |
| `plans` | PK `id`, check `type IN ('account','user')`, partial unique indexes |
| `plan_assignments` | PK `id`, partial unique current assignments, exclusion constraint, trigger |
| `usage_counters` | PK `id`, unique `(account_id, user_id, period_start)`, `user_id=NULL` sentinel |
| `usage_requests` | PK `id`, unique `(account_id, idempotency_key)`, hash + decision |
| `api_keys` | PK `id`, unique `prefix`, hash, revocation flags |

**Custom SQL Migrations (`src/db/sql/`):**
- `btree_gist` extension
- Check constraints (plan type, positive values, non-negative counters)
- Partial unique indexes (system/custom plans, current assignments, counters)
- Exclusion constraint on `plan_assignments` (no overlapping periods)
- Trigger for plan-type compatibility (account plan ↔ account assignment)

---

## Important Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Tenant isolation | All queries scoped by `account_id` from authenticated API key |
| No quota over-consumption | `SELECT FOR UPDATE` on counters + atomic increment within transaction |
| Idempotency | Unique constraint on `(account_id, idempotency_key)` + request hash comparison |
| Plan-type match | PostgreSQL trigger on `plan_assignments` |
| No overlapping assignments | Exclusion constraint on `tstzrange` |
| User belongs to account | Composite FK `(account_id, user_id) → users(account_id, id)` |
| Counters never negative | `CHECK (counter >= 0)` + atomic updates |
| Positive units | `CHECK (units > 0)` in DB + Zod validation |
| Monthly UTC periods | Computed once per request via `domain/date.ts` |

---

## Concurrency Scenarios Handled

| Scenario | Protection |
|----------|------------|
| Concurrent same idempotency key | Unique constraint serializes; second sees existing record |
| Concurrent different keys, last units | Counter lock serializes; exactly N accepted for N remaining |
| Concurrent first counter creation | Atomic upsert creates once; both get locked row |
| Deadlock | Retry with backoff (3×) on `40P01` / `40001` |
| Month boundary crossing | Period computed once before transaction |

---

## Known Limitations

1. **Rate Limiter**: In-memory by default; Redis available for multi-instance (falls back to memory on connection failure)
2. **Idempotency Key Retention**: Indefinite; no TTL or archival
3. **No Distributed Tracing**: Single-instance observability only
4. **Horizontal Scaling**: Single app instance; rate limiter state not shared without Redis

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
| Next-month plan changes | Prevents mid-month quota gaming; auditable |
| Idempotency in `usage_requests` | No separate table; atomic with decision persistence |

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
