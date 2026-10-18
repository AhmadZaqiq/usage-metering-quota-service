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
- **Rate Limiting**: Two layers — per-IP before authentication, per-API-key after; Redis-backed with in-process fallback (falling back to a bounded in-memory store per instance; if both stores fail, requests are rejected 429 — fail-closed)
- **Docker Support**: Docker Compose for local development with PostgreSQL 16
- **Example Client**: Demo CLI that walks the full lifecycle end to end (accept, all three rejections, plan changes, idempotent replay)
- **Accounting Invariant Verifier**: `verify-invariants` script cross-checks counters against the decision log and exits non-zero on any mismatch

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

- **Pure Quota Evaluator**: `quotaEvaluator.ts` is a pure function with no DB/HTTP dependencies; remaining balances are clamped at zero (never negative) when an allowance is lowered below already-consumed usage
- **Nullable user_id**: `NULL` user_id represents account-level counters (avoids partial index ORM issues; partial unique indexes enforce uniqueness per NULL vs non-NULL)
- **Idempotency in `usage_requests`**: No separate table; unique constraint on `(account_id, idempotency_key)` + request hash
- **Immediate Plan Changes**: Plan switches apply to the very next request; the current assignment is closed at the replacement's start (half-open chain) and pending rows are superseded. Counters are never reset. Changes are stamped only after row locks are acquired, so a wait cannot backdate them
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

Rejected requests never consume quota: their decision is recorded in the `usage_requests` decision log (for audit and idempotent replay), but the counters are not incremented. Validation failures (`400`) are rejected before the service runs and persist nothing.

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
- **Assignment Lock Order**: Target plan row → subject's assignment rows (`FOR UPDATE`); assignment decisions are stamped with a clock read taken *after* the locks are acquired
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

Plan changes follow an **immediate** model: the new assignment takes effect on the very next usage request.

- `effectiveFrom` is optional. It is honored only for the **first** assignment to a subject (no current assignment). When a current assignment exists, the change starts **now** (stamped after locks are acquired), regardless of the client-provided value.
- Switching plans closes the current assignment at the replacement's start (half-open intervals: `effectiveTo` equals the successor's `effectiveFrom`), so exactly one assignment is in effect at any instant. History rows are never deleted.
- A newer change also **supersedes** any not-yet-effective (pending) row for the same subject; the superseded row becomes a zero-width audit artifact (`effectiveTo = effectiveFrom`) and never covers any instant.
- Usage counters are **never reset** by a plan change. Remaining quota = effective plan's allowance − usage already consumed this UTC month.
- Lowering an allowance **below already-consumed usage** clamps remaining to `0` (never negative); further requests at that level are rejected (`account_quota_exceeded` / `user_quota_exceeded`) until the allowance is raised again. Raising applies immediately.
- Assignment responses return full ISO-8601 instants for `effectiveFrom`/`effectiveTo`.
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
| `GET` | `/usage` | Yes | Usage decision history (paginated: `page`, `limit`) |

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
    "code": "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "AUTHORIZATION_FAILED" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" | "INTERNAL_ERROR",
    "message": "Human-readable description",
    "details": {}
  }
}
```

| HTTP Status | Error Code | Meaning |
|-------------|------------|---------|
| 400 | `VALIDATION_ERROR` | Invalid request body/params (e.g., empty `userId`, malformed `units`, malformed JSON payload) |
| 401 | `AUTHENTICATION_FAILED` | Missing, malformed, unknown, or revoked API key; inactive or deleted account |
| 403 | `AUTHORIZATION_FAILED` | Authenticated but not allowed (cross-tenant resource, ownership violation) |
| 404 | `NOT_FOUND` | Resource not found, soft-deleted, or `userId` not in this account; plan vanished while waiting for a lock |
| 409 | `CONFLICT` | Idempotency key reused with different payload; no effective account/user plan (fail-closed); plan currently or pending assigned (delete/deactivate); overlapping assignment; assignment subject/plan conflict |
| 413 | `PAYLOAD_TOO_LARGE` | Request body above the 64 KB limit |
| 429 | `RATE_LIMITED` | Rate limit exceeded (per-IP or per-API-key layer); includes `Retry-After` and `X-RateLimit-*` headers |
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
# If a local PostgreSQL already occupies port 5432, publish elsewhere:
#   POSTGRES_PORT=5434 docker compose up -d --build
docker compose up -d --build

# On the FIRST start, the logs contain the generated key — save it:
docker compose logs app | grep -A1 "BOOTSTRAP API KEY"
```

Migrations are forward-only and idempotent (advisory-locked), so restarts are safe. The key is persisted to the `bootstrap-secrets` volume at `/run/secrets/api-key` (mode 0600) and reused on later restarts; it is never re-printed. To rotate or rerun bootstrap manually inside the container:

```bash
docker compose exec app node dist/scripts/bootstrap.js
```

The bootstrap command outputs the full API key **once** — save it. The `client` service runs the demo CLI against `http://app:3000` using that key:

```bash
docker compose run --rm client
```

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

### Example Client (Demo CLI)

`src/scripts/client.ts` is an HTTP-only example tenant client with two modes:

```bash
# Demo walkthrough (default): health gate, 3 fresh demo users, accepted usage,
# user/account/per-request rejections, immediate plan changes, idempotent
# replay, credential + input rejections, history/assignment summary.
# Exit code 0 = all checks passed; the full API key is never printed.
npm run client -- -k <API_KEY>            # key also read from /run/secrets/api-key
npm run client                            # Docker Compose: reads the secrets volume

# Single request mode
npm run client -- -n 5 -i req-001 --userId user123 -k <API_KEY>

npm run client -- --help
```

Inside Docker Compose the demo runs as its own one-shot service:

```bash
docker compose run --rm client    # target http://app:3000, key from /run/secrets
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
| `npm run client` | Run example CLI client (demo walkthrough by default) |
| `npm run verify:invariants` | Cross-check usage counters against the decision log |

### Testing

```bash
# Run all tests
npm test

# With coverage
npm run test:coverage
```

Tests use real PostgreSQL (test database via Docker Compose). No mocks for database behavior. The suite includes unit tests (pure domain), HTTP integration tests through the real Express pipeline (auth, validation, usage decisions, rate limiting), concurrency tests, and direct-SQL constraint proofs.

After running the demo or a load test, verify that counters still match the decision log:

```bash
docker compose run --rm app node dist/scripts/verify-invariants.js
# or locally against a configured DATABASE_URL:
npm run verify:invariants
```

The script checks account/user counters against accepted usage, non-negative stored remainings, UTC period alignment, tenant pairing, idempotency-key uniqueness, and exits non-zero on any violation.

### Load Testing

```bash
# Start the stack with the rate limiter raised (measurement only)
RATE_LIMIT_MAX=10000000 docker compose up -d --build

# Bootstrap a load-test account inside the app container (prints the key once)
docker compose run --rm \
  -e BOOTSTRAP_ACCOUNT_NAME=loadtest-account \
  -e BOOTSTRAP_API_KEY_NAME=loadtest-key \
  app node dist/scripts/bootstrap-loadtest.js

# Run load test with the generated API key (localhost targets only)
export LOADTEST_API_KEY=<your-key>
npm run loadtest -- --duration 30 --connections 10 --pipelining 1 --units 1

# Verify invariants, then restore the default rate limit
docker compose run --rm app node dist/scripts/verify-invariants.js
docker compose up -d app
```

A recorded run with full method and database evidence: [`docs/performance/2026-10-18-compose.md`](docs/performance/2026-10-18-compose.md).

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
│   ├── client.ts               # Example CLI client: demo walkthrough + single request
│   ├── loadtest.ts             # Autocannon load test script
│   └── verify-invariants.ts    # Accounting invariant checks (counters vs decision log)
└── test/
    ├── setup.ts                # Test database lifecycle (migrate, truncate)
    ├── utils.ts                # Test helper functions
    ├── assignmentPolicy.test.ts # Immediate changes, supersession, EPQ lock races, BR-13
    ├── bootstrap.test.ts       # Bootstrap integration tests
    ├── boundary.test.ts        # Quota, bigint, idempotency, plan boundary tests
    ├── concurrency.test.ts     # Concurrent quota consumption, idempotency tests
    ├── config.test.ts          # TRUST_PROXY and env validation tests
    ├── dbConstraints.test.ts   # Direct-SQL proof of DB constraints (incl. composite FKs)
    ├── hash.test.ts            # API key hashing / timing-safe comparison tests
    ├── healthFailure.test.ts   # Health endpoint failure redaction
    ├── httpAuth.test.ts        # HTTP auth + tenant isolation (real Express pipeline)
    ├── httpRateLimit.test.ts   # HTTP 429 budget exhaustion (own file, isolated store)
    ├── httpScenarios.test.ts   # End-to-end HTTP quota decisions, history, plan flow
    ├── httpStatus.test.ts      # Status-code and error-mapping tests
    ├── httpValidation.test.ts  # Schema-boundary validation incl. malformed JSON/413
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
5. **Performance Baseline**: A dated measurement of the Compose stack exists ([`docs/performance/2026-10-18-compose.md`](docs/performance/2026-10-18-compose.md)) but is not re-run for every change; numbers describe a single development machine.
6. **No Independent Security Audit**: The "Security" section describes implemented controls with tests; it is not a substitute for a professional assessment (see portfolio notice above).
7. **`drizzle-orm` Advisory CVE-2026-39356 (GHSA-gpj5-g38j-94v9, high)**: Affects identifier-escaping (`sql.identifier()` / `.as()`) when untrusted input reaches identifier construction. This codebase builds identifiers only from static schema objects and internal constants (the only `sql.raw()` usage interpolates compile-time conflict-target strings; no `sql.identifier()` calls exist), which the advisory explicitly scopes out of impact. Upgrading `drizzle-orm` 0.33 → 0.45.x is a breaking-change maintenance item scheduled after this milestone, not silently ignored.

---

## Performance Baseline

Load testing was performed with Autocannon against the Docker Compose stack (app + PostgreSQL 16 + Redis in containers) on a single development machine. Results are a local baseline for the recorded environment, not a universal production capacity guarantee.

### Test Environment (2026-10-18)

- Host: Linux x86_64, 12 CPU cores, 7.9 GB RAM
- App: `node:22-alpine` in Docker Compose
- PostgreSQL 16.15 and Redis 7 in Docker Compose
- Rate limit raised to `RATE_LIMIT_MAX=10000000` for the measurement window only (default is 100 req/60s per layer)
- Account-scoped authenticated `POST /usage`, `units=1`, unique idempotency key per request, pipelining 1

### Baseline Results (30s, 10 connections)

| Metric | Value |
|--------|-------|
| Requests/second (mean) | 120.40 |
| Total requests | 3,622 |
| p50 | 17 ms |
| p90 | 242 ms |
| p99 | 546 ms |
| Max | 922 ms |
| Errors / timeouts / non-2xx | 0 / 0 / 0 |

After the run the database showed 3,622 accepted / 0 rejected requests and an account counter exactly equal to the accepted sum; the invariant verifier passed for the whole database. Throughput is limited by the per-request transaction (counter lock + decision-log insert + commit); with 10 connections at ~82 ms mean latency, the observed rate matches the latency-bound prediction (≈122 req/s).

Full method, database evidence, and reproduction steps: [`docs/performance/2026-10-18-compose.md`](docs/performance/2026-10-18-compose.md).

---

## License

MIT — see [LICENSE](LICENSE).

---

## Author

Ahmad Zaqiq — Computer Systems Engineering graduate, Palestine Polytechnic University.