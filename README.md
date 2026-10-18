# Usage Metering & Quota Service

A professional, backend-only Usage Metering & Quota Service built with TypeScript, Node.js, Express, and PostgreSQL. This service accepts authenticated usage requests, evaluates account-level and user-level quotas, records decisions, and ensures usage cannot be consumed more than once through retries or concurrent requests.

> **Portfolio Project Notice**: This is a learning and portfolio project demonstrating backend engineering practices. Performance and security guarantees have not been independently verified. Known issues are documented below.

---

## Features

- **API-Key Authentication**: Secure API keys with SHA-256 hashing, prefix identification, and revocation
- **Tenant Isolation**: All operations scoped to authenticated account; no client-supplied account IDs trusted
- **Plan Management**: System-defined plans and account-owned custom plans with activation/deactivation
- **Plan Assignments**: Account-level and user-level assignments with effective dates and history
- **Monthly Quota Periods**: UTC-based monthly accounting with separate account and user counters
- **Idempotency**: Deterministic request hashing prevents duplicate consumption on retries
- **Concurrency Safety**: Pessimistic locking (`SELECT FOR UPDATE`) with consistent lock ordering
- **Structured Logging**: Pino-based request/decision logging with correlation IDs
- **Health Endpoints**: Liveness (`/health/live`) and readiness (`/health/ready`) probes
- **Rate Limiting**: Two layers — per-IP before authentication, per-API-key after; Redis-backed with in-process fallback (fail-closed if both stores fail)
- **Redis-backed Distributed Rate Limiting**: Optional Redis store for multi-instance deployments (falls back to in-memory)
- **Docker Support**: Docker Compose for local development with PostgreSQL 16

---

## Architecture

### Dependency Direction

```mermaid
graph TD
    A[Presentation: Routes + Middleware] --> B[Application: Use Case Services]
    B --> C[Domain: Pure Business Rules]
    C --> D[Infrastructure: Repositories + External]
    D --> E[Database: PostgreSQL + Drizzle]
    
    F[Cross-cutting: Config, Logging, Errors, Validation] -.-> A
    F -.-> B
    F -.-> D
```

### Module Responsibilities

| Layer | Module | Responsibility |
|-------|--------|----------------|
| Presentation | `presentation/routes/` | HTTP request/response handling, status codes, response serialization |
| Presentation | `presentation/middleware/` | Authentication, async error wrapping |
| Application | `application/auth/` | API key lifecycle business rules |
| Application | `application/plans/` | Plan CRUD, assignment lifecycle, overlap rules |
| Application | `application/usage/` | Transactional usage processing, idempotency |
| Application | `application/users/` | User management within an account |
| Application | `application/health/` | Health check logic |
| Domain | `domain/` | Pure quota evaluation, idempotency hashing, date utilities |
| Infrastructure | `infrastructure/repositories/` | All database queries (Drizzle + raw SQL) |
| Infrastructure | `infrastructure/auth/` | API key verification (repository + crypto) |
| Infrastructure | `infrastructure/rateLimiter.ts` | Rate limiting (in-memory + Redis) |
| Cross-cutting | `config/` | Environment validation |
| Cross-cutting | `errors/` | Error types and HTTP error mapping |
| Cross-cutting | `logging/` | Structured logging with correlation IDs |
| Cross-cutting | `validation/` | Zod input validation schemas |

### Key Design Decisions

- **Pure Quota Evaluator**: `quotaEvaluator.ts` is a pure function with no DB/HTTP dependencies
- **Nullable user_id**: `NULL` user_id represents account-level counters (avoids partial index ORM issues; partial unique indexes enforce uniqueness per NULL vs non-NULL)
- **Idempotency in `usage_requests`**: No separate table; unique constraint on `(account_id, idempotency_key)` + request hash
- **Asymmetric Plan Changes**: Upgrades take effect immediately; downgrades take effect at the next UTC month boundary (prevents mid-month quota gaming). Changes are stamped only after row locks are acquired, so a wait cannot backdate them
- **Fail-Closed Plan Requirements**: A user-scoped request with no effective user plan is rejected `409` — it never silently falls back to account-only quota
- **PostgreSQL Constraints as Source of Truth**: Exclusion constraints, triggers, composite tenant foreign keys, partial unique indexes enforce invariants

---

## Database Schema

### Entities

| Table | Purpose |
|-------|---------|
| `accounts` | Tenant accounts with soft delete |
| `users` | External user identities per account |
| `plans` | System and custom plans with ownership |
| `plan_assignments` | Account/user assignments with effective dates |
| `usage_counters` | Monthly quota counters (account + user) |
| `usage_requests` | Decision log + idempotency keys |
| `api_keys` | Hashed API keys with prefixes |

### Key Constraints

- **Partial Unique Indexes**: One current account-level assignment per account, one current user-level assignment per user; one live account name; soft-delete-aware plan name uniques
- **Exclusion Constraints**: `no_overlap_account_assignments` and `no_overlap_user_assignments` (partial, `btree_gist`) prevent overlapping assignment periods per subject; `chk_assignment_range` rejects inverted ranges
- **Trigger**: Enforces plan-type compatibility (account plan ↔ account assignment, user plan ↔ user assignment)
- **Composite Tenant FKs**: `(account_id, user_id) → users(account_id, id)` on `usage_counters`, `usage_requests`, and `plan_assignments` guarantees the user belongs to the stated account (NULL user_id passes via MATCH SIMPLE)
- **Check Constraints**: Positive allowances, positive units, non-negative counters

---

## Quota Evaluation

### Monthly Periods
- All periods computed in UTC in the application (`domain/date.ts` → first instant of the current UTC month)
- Period represented as `DATE` (first day of month, e.g., `2026-10-01`)
- Computed once per request (before the transaction) and passed through the transaction unchanged

### Decision Logic
For each request, the service evaluates (in order):

1. **Per-request maximum**: `units ≤ min(account_plan.max_units_per_request, user_plan?.max_units_per_request)`
2. **Account quota**: `units ≤ account_plan.monthly_allowance - account_counter`
3. **User quota** (if applicable): `units ≤ user_plan.monthly_allowance - user_counter`

### Fail-Closed Plan Requirements

Missing plan configuration is a **state conflict**, not a quota outcome:

- No effective **account** plan → `409 CONFLICT` (`No active account plan assigned`)
- `userId` supplied but no effective **user** plan → `409 CONFLICT` (`No active user plan assigned for user`) — no silent account-only fallback
- Account-scoped requests (no `userId`) intentionally use account quota only

Rejected requests never consume quota; failed checks roll back the whole transaction (no counter rows, no request row).

### Response Fields
```json
{
  "decision": "accepted" | "rejected",
  "rejectionReason": "account_quota_exceeded" | "user_quota_exceeded" | "max_per_request_exceeded",
  "accountRemaining": "995",
  "userRemaining": "495",
  "periodStart": "2026-10-01"
}
```

---

## Idempotency & Concurrency

### Idempotency
- Client supplies `idempotencyKey` (1-255 chars); `userId` (if present) must be non-empty
- Server computes SHA-256 hash of canonical request: `{ accountId, userId, units }`
- **Same key + same hash** → returns original decision (no additional quota consumed)
- **Same key + different hash** → `409 Conflict`
- Unique constraint on `(account_id, idempotency_key)` prevents duplicate processing
- **Keys are unique per account for the life of the account, not per month**: a replayed key returns the original committed decision — including its original `periodStart` and remaining values — and never consumes quota in the current period

### Concurrency Strategy
- **Isolation Level**: `READ COMMITTED` (PostgreSQL default)
- **Usage Lock Order**: Account counter → User counter (consistent ordering prevents deadlocks)
- **Counter Creation**: Atomic `INSERT ... ON CONFLICT DO UPDATE SET counter = counter` (no-op update acquires lock)
- **Assignment Lock Order**: Target plan row → subject's assignment rows (`FOR UPDATE`) → current plan row for allowance classification; assignment decisions are stamped with a clock read taken *after* the locks are acquired
- **Assign vs delete/deactivate**: the plan row is locked `FOR UPDATE` for the whole service transaction; a waiter re-evaluates `deleted_at`/`is_active` under READ COMMITTED (EvalPlanQual) and fails with `404`/`409` instead of acting on a stale row
- **Retry Policy**: 3 retries with exponential backoff (50/100/200ms) on deadlock (`40P01`) and serialization failure (`40001`), logged per retry

---

## API Reference

### Authentication
All protected endpoints require `Authorization: Bearer <api_key>` header.
API key format: `<prefix>.<secret>` (prefix stored plain, secret hashed with SHA-256)

### Endpoints

#### Health
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health/live` | No | Process liveness |
| `GET` | `/health/ready` | No | Database readiness |

#### API Keys
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api-keys` | Yes | Create key (returns full key once) |
| `GET` | `/api-keys` | Yes | List keys (prefix, name, revoked, created) |
| `DELETE` | `/api-keys/:id` | Yes | Revoke key |

#### Plans
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/plans` | Yes | Create custom plan |
| `GET` | `/plans` | Yes | List plans (system + own custom) |
| `GET` | `/plans/:id` | Yes | Get plan details |
| `PATCH` | `/plans/:id` | Yes | Update own custom plan |
| `DELETE` | `/plans/:id` | Yes | Soft delete own custom plan (409 if currently or pending assigned) |

#### Assignments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/assignments` | Yes | Assign plan to account/user |
| `GET` | `/assignments` | Yes | List all assignments (current + history) |
| `GET` | `/assignments/current` | Yes | Get current assignments |

##### Assignment timing

- **Upgrade** (higher or **equal** `monthlyAllowance` than the currently effective plan): takes effect **immediately**.
- **Downgrade** (strictly lower `monthlyAllowance`): takes effect at the **next UTC month start**.
- There is **at most one pending downgrade** per subject (account or user). A new upgrade supersedes any pending downgrade; a newer downgrade replaces the previous pending one.
- Usage counters are **never reset** by a plan change. Remaining quota uses the effective plan's allowance minus usage already consumed in the current UTC month.
- `effectiveFrom` is optional. It is honored only for the **first** assignment to a subject (no current assignment). When a current assignment exists, upgrades start now and downgrades start at the next UTC month regardless of the client-provided value.
- Assignment responses return full ISO-8601 instants for `effectiveFrom`/`effectiveTo`; immediate changes are stamped only after the row locks are acquired (a lock wait cannot backdate them).
- Soft-deleting or deactivating a plan that is current or pending for any subject returns **409 Conflict**. Reassign first.

#### Users
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/users` | Yes | Create user (external client_user_id) |
| `GET` | `/users` | Yes | List users in account |

#### Usage
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/usage` | Yes | Submit usage request |

### Usage Request
```json
POST /usage
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "userId": "ext-user-123",       // optional
  "units": "5",                    // string-encoded bigint, >0, ≤MAX_UNITS_PER_REQUEST
  "idempotencyKey": "req-abc-123" // required, 1-255 chars
}
```

### Usage Response (Accepted)
```json
{
  "decision": "accepted",
  "accountRemaining": "995",
  "userRemaining": "495",
  "periodStart": "2026-10-01"
}
```

### Usage Response (Rejected)
```json
{
  "decision": "rejected",
  "rejectionReason": "account_quota_exceeded",
  "accountRemaining": "0",
  "userRemaining": "495",
  "periodStart": "2026-10-01"
}
```

### Error Responses
All errors follow consistent format:
```json
{
  "error": {
    "code": "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "AUTHORIZATION_FAILED" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "INTERNAL_ERROR",
    "message": "Human-readable description",
    "details": {}
  }
}
```

| HTTP Status | Error Code | Meaning |
|-------------|------------|---------|
| 400 | `VALIDATION_ERROR` | Invalid request body/params (e.g., empty `userId`, malformed `units`) |
| 401 | `AUTHENTICATION_FAILED` | Missing, malformed, unknown, or revoked API key; inactive or deleted account |
| 403 | `AUTHORIZATION_FAILED` | Authenticated but not allowed (cross-tenant resource, ownership violation) |
| 404 | `NOT_FOUND` | Resource not found, soft-deleted, or `userId` not in this account; plan vanished while waiting for a lock |
| 409 | `CONFLICT` | Idempotency key reused with different payload; no effective account/user plan (fail-closed); plan currently or pending assigned (delete/deactivate); overlapping assignment; assignment subject/plan conflict |
| 429 | `RATE_LIMITED` | Rate limit exceeded (per-IP or per-API-key layer) |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Getting Started

### Prerequisites
- Docker and Docker Compose
- Node.js 20+ (for local development without Docker)
- Git

### Environment Configuration
Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

Required variables:
```env
DATABASE_URL=postgresql://app:app_secret@localhost:5432/usage_metering
MAX_UNITS_PER_REQUEST=10000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
LOG_LEVEL=debug
REDIS_URL=redis://redis:6379
TRUST_PROXY=false
```

### Docker Compose (Recommended)

The image is multi-stage (build → runtime, `node` user, production dependencies only) and the app container runs migrations, bootstrap, and the server in that order on every start:

```bash
# Build and start PostgreSQL, Redis, and the app (migrations + bootstrap run automatically)
docker compose up -d --build

# On the FIRST start, the logs contain the generated key — save it:
docker compose logs app | grep -A1 "BOOTSTRAP API KEY"
```

Migrations are forward-only and idempotent (advisory-locked), so restarts are safe. The key is persisted to the `bootstrap-secrets` volume at `/run/secrets/api-key` (mode 0600) and reused on later restarts; it is never re-printed. To rotate or rerun bootstrap manually inside the container:

```bash
docker compose exec app node dist/scripts/bootstrap.js
```

The bootstrap command outputs the full API key **once** — save it.

### Local Development (without Docker)

```bash
# Install dependencies
npm install

# Start PostgreSQL separately (ensure DATABASE_URL in .env points to it)

# Run migrations
npm run db:migrate

# Start development server with hot reload
npm run dev
```

### Example API Usage

```bash
# 1. Create a user
curl -X POST http://localhost:3000/users \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"clientUserId": "user123"}'

# 2. Create an account plan
curl -X POST http://localhost:3000/plans \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Pro Plan", "type": "account", "monthlyAllowance": "1000", "maxUnitsPerRequest": "100"}'

# 3. Create a user plan
curl -X POST http://localhost:3000/plans \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name": "User Tier", "type": "user", "monthlyAllowance": "100", "maxUnitsPerRequest": "10"}'

# 4. Assign plans
curl -X POST http://localhost:3000/assignments \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"planId": 1}'

curl -X POST http://localhost:3000/assignments \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user123", "planId": 2}'

# 5. Submit usage
curl -X POST http://localhost:3000/usage \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user123", "units": "5", "idempotencyKey": "req-001"}'
```

### Example Client
A simple CLI client is included:

```bash
npm run client -- -k <API_KEY> -n 5 -i req-001 [--userId user123] [-u http://localhost:3000]
```

---

## Development

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript |
| `npm run start` | Run compiled JS |
| `npm run lint` | ESLint with TypeScript rules |
| `npm run format` | Prettier formatting |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Run Vitest suite |
| `npm run test:watch` | Watch mode for tests |
| `npm run test:coverage` | Run suite with `@vitest/coverage-v8` |
| `npm run db:generate` | Generate Drizzle migration |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run bootstrap` | Create initial account + API key |
| `npm run bootstrap:loadtest` | Create load test account + API key |
| `npm run loadtest` | Run Autocannon load test |
| `npm run client` | Run example CLI client |

### Testing

```bash
# Run all tests
npm test

# With coverage
npm run test:coverage
```

Tests use real PostgreSQL (test database via Docker Compose). No mocks for database behavior.

### Load Testing

```bash
# Bootstrap a test account
export BOOTSTRAP_ACCOUNT_NAME=loadtest-account
export BOOTSTRAP_API_KEY_NAME=loadtest-key
npm run bootstrap:loadtest

# Run load test with the generated API key
export LOADTEST_API_KEY=<your-key>
npm run loadtest -- --duration 10 --connections 10 --pipelining 1 --units 1
```

---

## Project Structure

```
src/
├── main.ts                     # Entry point, graceful shutdown
├── app.ts                      # Express app factory, middleware wiring
├── config/
│   └── index.ts                # Zod-validated environment configuration
├── db/
│   ├── client.ts               # Connection pool (statement_timeout), Drizzle client, retrying transactions
│   ├── migrate.ts              # Migration runner (advisory-locked)
│   ├── schema/                 # Drizzle table definitions (7 tables)
│   ├── migrations/             # Drizzle-generated SQL migrations
│   └── sql/                    # Custom SQL (constraints, triggers, extensions; 0004_integrity_fixes.sql)
├── domain/                     # Pure business rules (no framework/DB imports)
│   ├── quotaEvaluator.ts       # Quota decision logic (pure function)
│   ├── idempotency.ts          # Request hash computation
│   ├── date.ts                 # UTC month start utilities
│   ├── hash.ts                 # Cryptographic helpers (SHA-256, random key gen)
│   └── pgError.ts              # PostgreSQL error code detection
├── application/                # Use cases / business services
│   ├── auth/
│   │   └── apiKeyService.ts    # API key lifecycle (create, list, revoke)
│   ├── plans/
│   │   ├── planService.ts      # Plan CRUD, ownership, activation
│   │   ├── assignmentService.ts # Assignment lifecycle, overlap prevention
│   │   └── assignmentHistoryService.ts # List current + historical assignments
│   ├── usage/
│   │   ├── usageService.ts     # Transactional usage processing, idempotency
│   │   └── usageHistoryService.ts # Paginated usage request history
│   ├── users/
│   │   └── userService.ts      # User CRUD within an account
│   └── health/
│       └── healthService.ts    # Liveness and readiness checks
├── infrastructure/             # Infrastructure implementations
│   ├── repositories/           # Data access (all Drizzle/raw SQL queries)
│   │   ├── accountRepository.ts
│   │   ├── apiKeyRepository.ts
│   │   ├── assignmentRepository.ts
│   │   ├── counterRepository.ts
│   │   ├── planRepository.ts
│   │   ├── usageRequestRepository.ts
│   │   └── userRepository.ts
│   ├── auth/
│   │   └── apiKeyAuthService.ts # API key verification (repository + hash)
│   └── rateLimiter.ts          # In-memory + Redis rate limiting
├── presentation/               # HTTP layer (Express)
│   ├── middleware/
│   │   ├── authMiddleware.ts   # Bearer token authentication
│   │   └── asyncHandler.ts     # Async route error wrapping
│   └── routes/
│       ├── apiKeyRoutes.ts     # POST/GET/DELETE /api-keys
│       ├── assignmentRoutes.ts # POST/GET /assignments, GET /assignments/current
│       ├── healthRoutes.ts     # GET /health/live, GET /health/ready
│       ├── planRoutes.ts       # CRUD /plans
│       ├── usageRoutes.ts      # POST /usage, GET /usage (history)
│       └── userRoutes.ts       # POST/GET /users
├── errors/
│   ├── AppError.ts             # Typed error classes
│   └── errorHandler.ts         # Express error middleware, HTTP status mapping
├── logging/
│   └── logger.ts               # Pino structured logger with request correlation
├── validation/
│   └── schemas.ts              # Zod input validation schemas
├── scripts/
│   ├── bootstrap.ts            # Create initial account, plan, assignment, API key
│   ├── bootstrap-loadtest.ts   # Create load-test account, plans, user, API key
│   ├── client.ts               # Example CLI client for /usage endpoint
│   └── loadtest.ts             # Autocannon load test script
└── test/
    ├── setup.ts                # Test database lifecycle (migrate, truncate)
    ├── utils.ts                # Test helper functions
    ├── assignmentPolicy.test.ts # Supersession policy, EPQ lock races, BR-13/CON-04
    ├── bootstrap.test.ts       # Bootstrap integration tests
    ├── boundary.test.ts        # Quota, bigint, idempotency, plan boundary tests
    ├── concurrency.test.ts     # Concurrent quota consumption, idempotency tests
    ├── config.test.ts          # TRUST_PROXY and env validation tests
    ├── dbConstraints.test.ts   # Direct-SQL proof of DB constraints (incl. composite FKs)
    ├── hash.test.ts            # API key hashing / timing-safe comparison tests
    ├── healthFailure.test.ts   # Health endpoint failure redaction
    ├── httpAuth.test.ts        # HTTP auth + tenant isolation (real Express pipeline)
    ├── httpStatus.test.ts      # Status-code and error-mapping tests
    ├── httpValidation.test.ts  # Schema-boundary validation (empty userId → 400)
    ├── logger.test.ts          # Credential redaction in structured logs
    ├── quotaEvaluator.test.ts  # Pure function unit tests (no DB)
    ├── rateLimiter.test.ts     # Two-layer limiter, fallback, fail-closed tests
    └── rollback.test.ts        # Transaction rollback via real service + triggers
```

---

## Security

- **No Client-Trust**: Account ID derived from authenticated API key only
- **Secret Handling**: API key secrets never logged; only prefix + SHA-256 hash stored; comparisons are timing-safe; bootstrap key file is mode 0600
- **Log Redaction**: Pino redacts `authorization` / `x-api-key` / `cookie` fields anywhere in log objects
- **Parameterized Queries**: Drizzle ORM prevents SQL injection
- **Rate Limiting**: Per-IP before authentication, per-API-key after (defaults: `RATE_LIMIT_MAX` = 100 requests per `RATE_LIMIT_WINDOW_MS` = 60s, applied independently to each layer); Redis-backed when `REDIS_URL` is set with in-process fallback; if both stores fail, requests are rejected `429` (fail-closed)
- **Request Size Limit**: 64KB body limit; server `requestTimeout` 15s, `headersTimeout` 10s
- **Database Bounds**: Pool `statement_timeout` 15s so runaway statements cannot pin connections
- **CORS**: Not configured; API key authentication provides primary access control. Configure CORS in `app.ts` if browser-based clients are needed.
- **HTTPS**: Terminates at reverse proxy in production (not included)
- **Proxy Trust**: `TRUST_PROXY=true` only when behind a trusted reverse proxy; otherwise forwarded headers (e.g., `X-Forwarded-For`) could be spoofed by clients
- **Input Validation**: Zod schemas at all boundaries (including non-empty `userId`)
- **Tenant Pairing at the DB**: Composite FKs prevent cross-account `(account_id, user_id)` rows even if application code is buggy

---

## Known Limitations & Deferred Findings

Honest status of items that are deliberately not done:

1. **Idempotency Key Retention**: Keys are unique per account indefinitely; no TTL/archival — the `usage_requests` table grows without bound. A retention job is out of scope for this milestone.
2. **`int8` Type Parser (audit DB-08)**: PostgreSQL `BIGINT` values are coerced to native `bigint` at repository mapping boundaries (and via Drizzle `mode: "bigint"`) instead of installing a global `pg` type parser. A global parser would also affect health checks, migrations, and any future raw client usage; the localized approach is explicit and test-covered.
3. **Single-Instance Rate Limiting**: Without `REDIS_URL`, per-IP/per-key counters are per-process; multi-instance deployments require Redis. Redis failure degrades to a bounded in-process store per instance (still enforced, not shared).
4. **No Distributed Tracing / Metrics**: Structured logs with request IDs only; no OpenTelemetry or Prometheus.
5. **Performance Baseline**: The load-test numbers below are a historical local measurement, not re-run for every change.
6. **No Independent Security Audit**: The "Security" section describes implemented controls with tests; it is not a substitute for a professional assessment (see portfolio notice above).
7. **`drizzle-orm` Advisory CVE-2026-39356 (GHSA-gpj5-g38j-94v9, high)**: Affects identifier-escaping (`sql.identifier()` / `.as()`) when untrusted input reaches identifier construction. This codebase builds identifiers only from static schema objects and internal constants (the only `sql.raw()` usage interpolates compile-time conflict-target strings; no `sql.identifier()` calls exist), which the advisory explicitly scopes out of impact. Upgrading `drizzle-orm` 0.33 → 0.45.x is a breaking-change maintenance item scheduled after this milestone, not silently ignored.

---

## Performance Baseline

Load testing was performed with Autocannon against the local application using real PostgreSQL. Results are a local baseline for the recorded environment, not a universal production capacity guarantee.

### Test Environment

- Node.js: 22.x
- PostgreSQL: 16 (local, Docker)
- Application: Express + Drizzle ORM + Pessimistic locking
- Rate limit: Disabled (RATE_LIMIT_MAX=10000000) for pure throughput measurement

### Baseline Results

| Connections | Duration | Req/s | p50 (ms) | p99 (ms) | Max (ms) | Errors |
|-------------|----------|-------|----------|----------|----------|--------|
| 10 | 10s | 116.20 | 67.00 | 362.00 | 684.00 | 0 |
| 25 | 10s | 125.40 | 171.00 | 773.00 | 1474.00 | 0 |

All tests used authenticated usage requests with unique idempotency keys per request. Throughput is limited by database writes (counter increment + usage_request insert) within a single transaction.

### Run Your Own Load Test

```bash
# Bootstrap a test account
export BOOTSTRAP_ACCOUNT_NAME=loadtest-account
export BOOTSTRAP_API_KEY_NAME=loadtest-key
npm run bootstrap:loadtest

# Run load test (use the API key printed above)
export LOADTEST_API_KEY=<your-key>
npm run loadtest -- --duration 10 --connections 10 --pipelining 1 --units 1
```

---

## License

MIT — see [LICENSE](LICENSE).

---

## Author

Ahmad Zaqiq — Computer Systems Engineering graduate, Palestine Polytechnic University.