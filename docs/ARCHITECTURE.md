# Architecture Documentation

## Overview

This document describes the actual implementation architecture of the Usage Metering & Quota Service. It reflects the code as written, not an idealized design.

---

## Layer Structure

```
┌─────────────────────────────────────────────────────────────┐
│                     HTTP Layer (Routes)                      │
│  usageRoutes, apiKeyRoutes, planRoutes, assignmentRoutes,   │
│  userRoutes, healthRoutes                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Application Services                        │
│  auth: apiKeyService, authMiddleware                         │
│  plans: planService, assignmentService                       │
│  usage: usageService, quotaEvaluator, counterRepository      │
│  health: healthService                                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Domain Layer                              │
│  quotaEvaluator (pure function)                              │
│  idempotency (hash computation)                              │
│  date utilities                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Persistence Layer                          │
│  Drizzle ORM schema definitions                              │
│  Transaction helper with retry logic                         │
│  Custom SQL migrations (constraints, triggers)               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    PostgreSQL 16                             │
└─────────────────────────────────────────────────────────────┘
```

### Cross-Cutting Concerns

| Concern | Implementation |
|---------|----------------|
| Configuration | Zod-validated `src/config/index.ts` |
| Logging | Pino with request correlation IDs (`src/logging/logger.ts`) |
| Error Handling | Typed error classes + Express middleware (`src/errors/`) |
| Validation | Zod schemas at route boundaries (`src/validation/schemas.ts`) |
| Rate Limiting | `express-rate-limit` with per-key/IP keys |
| Health Checks | `/health/live` (process), `/health/ready` (DB) |

---

## Module Details

### 1. Authentication (`src/modules/auth/`)

**Files:**
- `apiKeyService.ts` — Key lifecycle: create, verify, revoke, list
- `authMiddleware.ts` — Express middleware extracting Bearer token

**Key Design:**
- Key format: `<prefix>.<secret>` (prefix = 16 hex chars, secret = 64 hex chars)
- Only SHA-256(secret) + prefix stored; full key returned once
- Verification: `WHERE prefix = ? AND is_revoked = false` → SHA-256 compare
- Account status checked on every verification

**Security:**
- 256-bit entropy secrets (cryptographically secure random)
- SHA-256 sufficient for high-entropy secrets (no KDF needed)
- Never logs secrets; only prefix in structured logs

### 2. Plans & Assignments (`src/modules/plans/`)

**Files:**
- `planService.ts` — Plan CRUD, ownership, activation
- `assignmentService.ts` — Assignment lifecycle, overlap prevention

**Plan Types:**
- **System Plans**: `owner_account_id IS NULL`, globally unique by `(type, name)`
- **Custom Plans**: `owner_account_id = requesting_account`, unique per account

**Assignment Rules:**
- Account-level: `user_id IS NULL`, requires `plan.type = 'account'`
- User-level: `user_id NOT NULL`, requires `plan.type = 'user'`
- One current assignment per subject (partial unique indexes)
- Effective dates: `effective_from` (default now), `effective_to` (NULL = current)
- Overlap prevention: PostgreSQL exclusion constraint on `tstzrange`
- Plan-type enforcement: BEFORE INSERT/UPDATE trigger

**Plan Change Policy:**
- Changes take effect at **next UTC month boundary**
- Current month completes on old plan
- Implemented via `getNextUtcMonthStart()` in assignment service

### 3. Usage Processing (`src/modules/usage/`)

**Files:**
- `quotaEvaluator.ts` — **Pure function**, no external dependencies
- `counterRepository.ts` — Counter upsert-and-lock, increment
- `usageService.ts` — Transaction orchestration, idempotency, decision logic

#### Quota Evaluator (Pure)

```typescript
function evaluateQuota(input: {
  accountPlan: { monthlyAllowance: bigint; maxUnitsPerRequest: bigint }
  userPlan: { monthlyAllowance: bigint; maxUnitsPerRequest: bigint } | null
  accountUsed: bigint
  userUsed: bigint
  requestedUnits: bigint
}): { decision, rejectionReason?, accountRemaining, userRemaining? }
```

**Evaluation Order:**
1. `requestedUnits ≤ max_per_request` (min of account/user plan limits)
2. `requestedUnits ≤ account_remaining`
3. `requestedUnits ≤ user_remaining` (if user plan exists)

All arithmetic uses TypeScript `bigint` (matches PostgreSQL `BIGINT`).

#### Counter Repository

**Key Function:** `upsertAndLockCounter(tx, accountId, userId, periodStart)`

```sql
INSERT INTO usage_counters (account_id, user_id, period_start, counter)
VALUES (?, ?, ?, 0)
ON CONFLICT (account_id, user_id, period_start)
DO UPDATE SET counter = usage_counters.counter
RETURNING *
```

- `user_id = 0` sentinel for account-level counters
- Atomic create-or-lock; no separate SELECT FOR UPDATE needed
- Consistent lock order: account counter → user counter

#### Usage Service Transaction

```typescript
async function processUsageRequest(accountId, input, apiKeyId) {
  return withTransaction(async (tx) => {
    // 1. Resolve user if provided (validate ownership)
    // 2. Check idempotency key (SELECT existing)
    // 3. If exists + same hash → return original decision
    // 4. If exists + different hash → throw ConflictError
    // 5. Upsert + lock account counter (user_id = 0)
    // 6. Upsert + lock user counter if applicable
    // 7. Resolve current plans (account + user)
    // 8. Evaluate quota (pure function)
    // 9. Insert usage_requests with final decision
    // 10. If accepted → increment counters
    // 11. Return decision
  })
}
```

**Idempotency Flow:**
1. `SELECT FROM usage_requests WHERE account_id = ? AND idempotency_key = ?`
2. If found + hash matches → return original
3. If found + hash differs → `409 Conflict`
4. Not found → proceed with evaluation
5. Insert `usage_requests` with final decision
6. Unique constraint on `(account_id, idempotency_key)` prevents race

**Concurrency Control:**
- Isolation: `READ COMMITTED` (PostgreSQL default)
- Lock order: account counter → user counter
- Counter creation: atomic upsert acquires lock
- Retry: 3× on deadlock (`40P01`) / serialization (`40001`)

### 4. Database Schema

**Tables:**
| Table | Key Constraints |
|-------|-----------------|
| `accounts` | PK `id`, soft delete `deleted_at` |
| `users` | PK `id`, unique `(account_id, client_user_id)`, FK `account_id` |
| `plans` | PK `id`, check `type IN ('account','user')`, partial unique indexes |
| `plan_assignments` | PK `id`, partial unique current assignments, exclusion constraint, trigger |
| `usage_counters` | PK `id`, unique `(account_id, user_id, period_start)`, `user_id=0` sentinel |
| `usage_requests` | PK `id`, unique `(account_id, idempotency_key)`, hash + decision |
| `api_keys` | PK `id`, unique `prefix`, hash, revocation flags |

**Custom SQL Migrations (`src/db/sql/0001_custom_constraints.sql`):**
- `btree_gist` extension
- Check constraints (plan type, positive values)
- Partial unique indexes (system/custom plans, current assignments)
- Exclusion constraint on `plan_assignments` (no overlapping periods)
- Trigger `trg_check_plan_type_matches` (plan-type compatibility)

---

## Request Flow

```
POST /usage
    │
    ▼
Rate Limiter (per key prefix / IP)
    │
    ▼
Auth Middleware
    │  ├─ Extract Bearer token
    │  ├─ Verify API key (hash + account status)
    │  └─ Attach req.account { id }, req.apiKeyId
    ▼
Zod Validation (usageRequestSchema)
    │
    ▼
usageService.processUsageRequest()
    │  ├─ withTransaction (retry on deadlock)
    │  ├─ Resolve user (if provided)
    │  ├─ Check idempotency key
    │  ├─ Upsert + lock counters
    │  ├─ Resolve current plans
    │  ├─ quotaEvaluator.evaluateQuota()
    │  ├─ Insert usage_requests (decision)
    │  ├─ If accepted: increment counters
    │  └─ Return QuotaDecision
    ▼
HTTP Response (200 accepted/rejected, 409 conflict, etc.)
```

---

## Important Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Tenant isolation | All queries scoped by `account_id` from auth |
| No quota over-consumption | `SELECT FOR UPDATE` on counters + atomic increment |
| Idempotency | Unique constraint + request hash comparison |
| Plan-type match | Trigger on `plan_assignments` |
| No overlapping assignments | Exclusion constraint on `tstzrange` |
| User belongs to account | Composite FK `(account_id, user_id)` |
| Counters never negative | `CHECK (counter >= 0)` + atomic updates |
| Positive units | `CHECK (units > 0)` in DB + Zod validation |
| Monthly UTC periods | Computed once per request via `getUtcMonthStart()` |

---

## Data Flow: Quota Exhaustion Scenario

```
Initial: account monthly_allowance = 1000, counter = 998
Request: units = 5
──────────────────────────────────────────────
1. Lock account counter (SELECT FOR UPDATE)
2. accountRemaining = 1000 - 998 = 2
3. requestedUnits (5) > accountRemaining (2)
4. Decision: rejected, rejectionReason = "account_quota_exceeded"
5. Insert usage_requests (decision = 'rejected')
6. Counters NOT incremented
7. Return { decision: "rejected", rejectionReason, accountRemaining: "2" }
```

---

## Concurrency Scenarios Handled

| Scenario | Protection |
|----------|------------|
| Concurrent same idempotency key | Unique constraint serializes; second sees existing |
| Concurrent different idempotency keys, last units | Counter lock serializes; exactly N accepted for N remaining |
| Concurrent first counter creation | Atomic upsert creates once; both get locked row |
| Plan deactivation mid-transaction | Plans read after counter locks; `effective_to` guards |
| Month boundary crossing | Period computed once before transaction |
| Deadlock | Retry with backoff (3×) on `40P01` |

---

## Known Limitations

1. **Circular JSON Serialization**: Drizzle result objects contain circular references; needs explicit serialization in usage service
2. **Hardcoded Plan Type**: `mapAssignment` returns `"account"` instead of actual `plan.type`
3. **Rate Limiter**: In-memory; not suitable for multi-instance deployment
4. **Idempotency Key Retention**: Indefinite; no TTL or archival
5. **No Distributed Tracing**: Single-instance observability only

---

## Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Sentinel `user_id = 0` for account counters | Avoids partial unique index ORM limitations; simpler upsert |
| SHA-256 for API keys (not Argon2) | High-entropy secrets don't need KDF; 100K× faster verification |
| `READ COMMITTED` + explicit locks | Simpler than `SERIALIZABLE`; explicit locks are auditable |
| Next-month plan changes | Prevents mid-month quota gaming; auditable |
| Idempotency in `usage_requests` | No separate table; atomic with decision persistence |
| Pure quota evaluator | Testable without DB; deterministic for identical inputs |
| `bigint` for all quota values | Matches PostgreSQL `BIGINT`; no precision loss |

---

## Deployment Architecture

```
                    ┌─────────────┐
                    │   Client    │
                    └──────┬──────┘
                           │ HTTPS
                           ▼
                    ┌─────────────┐
                    │  Reverse    │  (nginx/Traefik/Caddy)
                    │   Proxy     │  TLS termination, CORS
                    └──────┬──────┘
                           │ HTTP (internal)
                           ▼
                    ┌─────────────┐
                    │   App       │  Node.js + Express
                    │  Container  │  (single instance)
                    └──────┬──────┘
                           │ TCP
                           ▼
                    ┌─────────────┐
                    │ PostgreSQL  │  16-alpine
                    │  Container  │  Persistent volume
                    └─────────────┘
```

---

## Future Architecture Considerations

- **Horizontal Scaling**: Replace in-memory rate limiter with Redis
- **High Availability**: PostgreSQL streaming replication + Patroni
- **Observability**: OpenTelemetry + Prometheus + Grafana
- **Idempotency TTL**: Partition `usage_requests` by month; archive old keys
- **Async API Key Usage Update**: `pg_notify` + background worker for `last_used_at`
- **Multi-Region**: Read replicas for read-heavy endpoints