# Usage Metering & Quota Service

A professional, backend-only Usage Metering & Quota Service built with TypeScript, Node.js, Express, and PostgreSQL. This service accepts authenticated usage requests, evaluates account-level and user-level quotas, records decisions, and ensures usage cannot be consumed more than once through retries or concurrent requests.

> **Portfolio Project Notice**: This is a learning and portfolio project demonstrating backend engineering practices. Performance and security guarantees have not been independently verified. Known issues are documented below.

---

## Features

- **API-Key Authentication**: Secure API keys with SHA-256 hashing, prefix identification, and revocation
- **Tenant Isolation**: All operations scoped to authenticated account; no client-supplied account IDs trusted
- **Seeded System Plans**: A predefined catalog (Starter, Pro, Basic, Premium) is idempotently seeded on every bootstrap; system plans are read-only for every tenant, while accounts can still create and manage their own custom plans
- **Plan Assignments**: Account-level and user-level assignments with effective dates and history
- **Monthly Quota Periods**: UTC-based monthly accounting with separate account and user counters
- **Idempotency**: Deterministic request hashing prevents duplicate consumption on retries
- **Concurrency Safety**: Counter rows are serialized by an upsert row lock (`INSERT ... ON CONFLICT DO UPDATE`) held to commit; plan and assignment rows use `SELECT FOR UPDATE` with consistent lock ordering
- **Per-Request Breach Scope**: A `max_per_request_exceeded` rejection reports which cap rejected the request (`global`, `account`, or `user`) so clients can tell a plan cap apart from the global limit
- **Structured Logging**: Pino-based request/decision logging with correlation IDs
- **Health Endpoints**: Liveness (`/health/live`) and readiness (`/health/ready`) probes
- **API Documentation**: OpenAPI 3.1 specification at `/docs/openapi.json` and interactive Swagger UI at `/docs`
- **Rate Limiting**: Two layers — per-IP before authentication, per-API-key after; enforced by a bounded in-process store per application instance (if the store fails, requests are rejected 429 — fail-closed)
- **Docker Support**: Docker Compose for local development with PostgreSQL 16; the container starts as root only to repair the secrets volume's ownership, then drops to the unprivileged `node` user before serving traffic
- **Example Client**: Demo CLI that walks the full lifecycle end to end (accepted usage, all three rejection types, divergent per-user plans, immediate plan changes, idempotent replay, and proof that rejected requests are preserved in history)
- **Accounting Invariant Verifier**: `verify-invariants` script cross-checks counters against the decision log and exits non-zero on any mismatch

---

## Architecture

### Dependency Direction

```mermaid
graph TD
    A[Presentation: Routes + Middleware] --> B[Application: Use Case Services]
    B --> C[Domain: Pure Business Rules]
    A --> D[Infrastructure: Repositories + External]
    B --> D
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
| Infrastructure | `infrastructure/rateLimiter.ts` | Rate limiting (bounded in-process store) |
| Cross-cutting | `config/` | Environment validation |
| Cross-cutting | `errors/` | Error types and HTTP error mapping |
| Cross-cutting | `logging/` | Structured logging with correlation IDs |
| Cross-cutting | `validation/` | Zod input validation schemas |

### Key Design Decisions

- **Seeded System Plans**: `bootstrap.ts` idempotently seeds a shared, ownerless catalog (Starter and Pro as account plans; Basic and Premium as user plans) on every run, using the `uq_system_plans` unique violation to make concurrent seeding safe. Seeded values are required exact values (`monthly_allowance` / `max_units_per_request`), enforced by `bootstrap.test.ts`: **Starter 10000/100 · Pro 1000000/1000 · Basic 500/20 · Premium 5000/200**. A fresh account is assigned **Starter** by default; accounts that already have a current assignment are left untouched. Because system plans have a `NULL` owner, `planService` rejects any attempt to modify or delete them (`403`), so the shared catalog is read-only for every tenant while custom plans remain fully manageable
- **Pure Quota Evaluator**: `quotaEvaluator.ts` is a pure function with no DB/HTTP dependencies; remaining balances are clamped at zero (never negative) when an allowance is lowered below already-consumed usage. When a request exceeds a per-request cap, the evaluator also reports *which* cap rejected it (`limitScope`: `global` / `account` / `user`)
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
  "limitScope": "global" | "account" | "user",
  "accountRemaining": "995",
  "userRemaining": "495",
  "periodStart": "2026-10-01"
}
```

`limitScope` is present **only** when `rejectionReason` is `max_per_request_exceeded`, and it identifies which per-request cap rejected the request:

| Value | Meaning |
|-------|---------|
| `global` | The request exceeded the server-wide `MAX_UNITS_PER_REQUEST` limit |
| `account` | The request exceeded the account plan's `maxUnitsPerRequest` (also used when caps are equal, or when no user plan applies) |
| `user` | The request exceeded the user plan's `maxUnitsPerRequest`, which was the tighter of the two caps |

It is not persisted, so an idempotent replay of a stored rejection omits it rather than re-evaluating quota.

---

## Idempotency & Concurrency

### Idempotency
- Client supplies `requestId` (1-255 chars); `idempotencyKey` is accepted as a deprecated alias for backward compatibility, and sending both fields is a `400`; `userId` (if present) must be non-empty
- `requestId` is the public contract name (request body and history responses); it maps to the unchanged `usage_requests.idempotency_key` storage column. It is unrelated to the `X-Request-Id` correlation header
- Server computes SHA-256 hash of canonical request: `{ accountId, userId, units }`
- **Same key + same hash** → returns original decision (no additional quota consumed)
- **Same key + different hash** → `409 Conflict`
- Unique constraint on `(account_id, idempotency_key)` prevents duplicate processing
- **Keys are unique per account for the life of the account, not per month**: a replayed key returns the original committed decision — including its original `periodStart` and remaining values — and never consumes quota in the current period

### Concurrency Strategy
- **Isolation Level**: `READ COMMITTED` (PostgreSQL default)
- **Usage Lock Order**: Accounts row (admission lock) → Account counter → User counter → API-key row (consistent ordering prevents deadlocks)
- **Month Boundary Policy**: the admission timestamp is sampled from the database clock (`clock_timestamp()`) *after* the account row lock is granted, and the same timestamp produces both the quota `periodStart` and the row's `created_at`. A request queued across a UTC month boundary is therefore charged to the month in which it is admitted, and `period_start` equals the UTC month of `created_at` for every request — there is no pre-lock clock window
- **Counter Creation**: Atomic `INSERT ... ON CONFLICT DO UPDATE SET counter = counter` (no-op update acquires lock)
- **Assignment Lock Order**: Target plan row → subject's assignment rows (`FOR UPDATE`); assignment decisions are stamped with a clock read taken *after* the locks are acquired
- **Assign vs delete/deactivate**: the plan row is locked `FOR UPDATE` for the whole service transaction; a waiter re-evaluates `deleted_at`/`is_active` under READ COMMITTED (EvalPlanQual) and fails with `404`/`409` instead of acting on a stale row
- **Retry Policy**: 3 retries with exponential backoff (50/100/200ms) on deadlock (`40P01`) and serialization failure (`40001`), logged per retry

---

## API Reference

Interactive documentation: `GET /docs` (Swagger UI). Machine-readable spec: `GET /docs/openapi.json` (OpenAPI 3.1, hand-maintained in `src/docs/openapi.ts`; the `docs.test.ts` smoke test fails if routers and spec drift apart).

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
| `GET` | `/api-keys` | Yes | List keys (id, prefix, name, revoked, lastUsedAt, created) |
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
| `GET` | `/usage` | Yes | Usage decision history (paginated: `page`, `limit`; optional `userId` filter — `clientUserId` resolved in the authenticated account, `404` if unknown) |

### Usage Request
```json
POST /usage
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "userId": "ext-user-123",  // optional
  "units": "5",              // string-encoded bigint, >0, ≤MAX_UNITS_PER_REQUEST
  "requestId": "req-abc-123" // required, 1-255 chars (idempotencyKey accepted as deprecated alias)
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

For a per-request-cap rejection, `limitScope` is also present:
```json
{
  "decision": "rejected",
  "rejectionReason": "max_per_request_exceeded",
  "limitScope": "user",
  "accountRemaining": "995",
  "userRemaining": "495",
  "periodStart": "2026-10-01"
}
```

### Error Responses
All errors follow consistent format:
```json
{
  "error": {
    "code": "VALIDATION_ERROR" | "AUTHENTICATION_FAILED" | "AUTHORIZATION_FAILED" | "NOT_FOUND" | "CONFLICT" | "IDEMPOTENCY_CONFLICT" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" | "INTERNAL_ERROR" | "TRANSACTION_CONFLICT" | "DATABASE_CAPACITY_EXCEEDED",
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
| 409 | `IDEMPOTENCY_CONFLICT` | Defensive mapping if a unique violation on `usage_requests` ever escapes the `ON CONFLICT DO NOTHING` write path (not expected in normal operation) |
| 413 | `PAYLOAD_TOO_LARGE` | Request body above the 64 KB limit |
| 429 | `RATE_LIMITED` | Rate limit exceeded (per-IP or per-API-key layer); normally includes `Retry-After` and `X-RateLimit-*` headers (the last-resort fail-closed path omits `Retry-After`) |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 503 | `TRANSACTION_CONFLICT` | Deadlock or serialization failure survived all transaction retries (40P01/40001); safe to retry the request |
| 503 | `DATABASE_CAPACITY_EXCEEDED` | Connection-pool acquisition timed out before any SQL ran (overload, not a fault); includes `Retry-After: 1`; safe to retry — idempotency keys make retries safe |

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

Only one variable is required; everything else has a working default:

```env
# Required
DATABASE_URL=postgresql://app:app_secret@localhost:5432/usage_metering

# Optional (defaults shown; see .env.example)
MAX_UNITS_PER_REQUEST=10000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
LOG_LEVEL=info
TRUST_PROXY=false
# Rate limiting is in-process per application instance: counters reset on
# process restart and are not shared across replicas (no external store).
```

### Docker Compose (Recommended)

The image is multi-stage (build → runtime, production dependencies only). The container starts as **root** only long enough for `docker-entrypoint.sh` to repair ownership of the `/run/secrets` volume (which Docker creates root-owned), then it drops to the unprivileged `node` user via busybox `su` before running migrations, bootstrap, and the server in that order on every start. The serving process therefore always runs as `node`:

```bash
# If a local PostgreSQL already occupies port 5432, publish elsewhere:
#   POSTGRES_PORT=5434 docker compose up -d --build
docker compose up -d --build

# On the FIRST start, the logs contain the generated key — save it:
docker compose logs app | grep -A1 "BOOTSTRAP API KEY"
```

Migrations are forward-only and idempotent (advisory-locked), so restarts are safe. The key is persisted to the `bootstrap-secrets` volume at `/run/secrets/api-key` (owned by `node`, mode `0600`; the directory is mode `0700`) and reused on later restarts; it is never re-printed. If the key file is missing but the key row survives (e.g. the volume was wiped), bootstrap rotates to a new key: it writes the replacement first, and only revokes the old key after the write succeeds, so a failed write can never strand the account with no usable key. To rotate or rerun bootstrap manually inside the container:

```bash
docker compose exec app node dist/scripts/bootstrap.js
```

#### Reconciling databases seeded before the exact-value catalog

`ensureSystemPlans` only inserts missing rows (`if (existing) continue`) — it never updates an existing plan. A database seeded with the older allowances keeps those values until an operator reconciles them. The following snippet is **document-only operator guidance**: review and run it deliberately against the target database; it is not part of migrations or bootstrap, and nothing in this repository executes it automatically.

```sql
UPDATE plans
SET monthly_allowance = v.allowance,
    max_units_per_request = v.max_units
FROM (VALUES
  ('Starter', 'account', 10000::bigint, 100::bigint),
  ('Pro',     'account', 1000000::bigint, 1000::bigint),
  ('Basic',   'user',    500::bigint, 20::bigint),
  ('Premium', 'user',    5000::bigint, 200::bigint)
) AS v(name, type, allowance, max_units)
WHERE plans.owner_account_id IS NULL
  AND plans.name = v.name
  AND plans.type = v.type
  AND plans.deleted_at IS NULL
  AND (plans.monthly_allowance <> v.allowance
    OR plans.max_units_per_request <> v.max_units);
```

The `bootstrap.test.ts` catalog test asserts the exact seeded values on a fresh test database, so a clean install is covered by CI without any reconciliation step.

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
  -d '{"userId": "user123", "units": "5", "requestId": "req-001"}'
```

### Example Client (Demo CLI)

`src/cli/` is an HTTP-only example tenant client with four commands:

```bash
# demo (default): end-to-end walkthrough — health gate, 3 fresh demo users on
# two different user plans (a small plan and a higher "Plus" plan, proving the
# same units yield different remainings and different accept/reject decisions),
# accepted usage, user/account/per-request rejections (including the reported
# limitScope), immediate plan changes, idempotent replay, credential + input
# rejections, and a history check proving rejected requests are preserved.
# Success prints "All demo assertions passed." and exits 0; when DATABASE_URL
# is set it also verifies accounting invariants and prints "All accounting
# invariants passed." (skipped with a note when DATABASE_URL is unset).
npm run client -- -k <API_KEY>            # key from the -k flag (works on the host)
npm run client                            # falls back to /run/secrets/api-key, which
                                          # exists inside Docker only — on the host, pass -k

# consume: one POST /usage (legacy -n/-i flags still map through)
npm run client -- consume -n 5 -i req-001 --userId user123 -k <API_KEY>

# usage: GET /usage filtered to one user; history: GET /usage paginated
npm run client -- usage --userId user123 -k <API_KEY>
npm run client -- history --page 1 --limit 10 -k <API_KEY>

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
| `npm run verify` | Typecheck + lint + build + full test suite |
| `npm run verify:all` | Everything in `verify`, then the accounting-invariant verifier (needs `DATABASE_URL` pointing at a migrated database) |
| `npm run db:generate` | Generate Drizzle migration |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run bootstrap` | Seed system plans, create initial account + API key, assign Starter |
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

Tests use real PostgreSQL (test database via Docker Compose). No mocks for database behavior. The suite includes unit tests (pure domain), HTTP integration tests through the real Express pipeline (auth, validation, usage decisions, rate limiting), concurrency tests, and direct-SQL constraint proofs. As of the latest run: **21 test files, 223 tests, all passing**.

For one command that runs the static checks, build, and suite and then cross-checks counters against the decision log:

```bash
DATABASE_URL=postgresql://app:app_secret@localhost:5432/usage_metering npm run verify:all
```

After running the demo or a load test, verify that counters still match the decision log:

```bash
docker compose run --rm app node dist/scripts/verify-invariants.js
# or locally against a configured DATABASE_URL:
npm run verify:invariants
```

The script checks account/user counters against accepted usage, non-negative stored remainings, UTC period alignment, tenant pairing, idempotency-key uniqueness, and exits non-zero on any violation.

### Compose Profiles (tests / app-test / loadtest)

Plain `docker compose up -d` is unchanged. Three profile-gated services cover the Docker-native verification and load workflows:

```bash
# 1. Full test suite inside Docker (build-stage image, dev dependencies,
#    migrations applied by the test setup itself) against postgres-test:
docker compose --profile tests run --rm tests

# 2. Disposable app stack on port 3001 with its own database container
#    (no named volume — pgdata/pgdata_test/bootstrap-secrets are untouched;
#    the bootstrap key is printed to this container's logs on first start):
RATE_LIMIT_MAX=10000000 docker compose --profile app-test up -d --build
curl -f http://localhost:3001/health/ready

# 3. Load test against app-test. loadtest.ts only accepts localhost targets,
#    so the generator runs with host networking and dials the published
#    port 3001:
KEY=$(docker compose exec -T app-test cat /run/secrets/api-key)
LOADTEST_API_KEY="$KEY" docker compose --profile loadtest run --rm loadtest -d 5 -c 10
```

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
Dockerfile                      # Multi-stage build; entrypoint drops root → node
docker-entrypoint.sh            # Repairs /run/secrets ownership, drops to node, runs CMD
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
│   │   ├── usageService.ts     # Transaction orchestration (single tx: resolve → replay check → lock → evaluate → persist)
│   │   ├── resolveUsageContext.ts # User resolution, counter locks, plan resolution (fail-closed)
│   │   ├── replayUsageRequest.ts # Idempotent replay lookup + hash-conflict detection
│   │   ├── persistUsageDecision.ts # Decision insert, conditional counter increments, last-used stamp
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
│   └── rateLimiter.ts          # In-process rate limiting (bounded store)
├── presentation/               # HTTP layer (Express)
│   ├── middleware/
│   │   ├── authMiddleware.ts   # Bearer token authentication
│   │   └── asyncHandler.ts     # Async route error wrapping
│   └── routes/
│       ├── apiKeyRoutes.ts     # POST/GET/DELETE /api-keys
│       ├── assignmentRoutes.ts # POST/GET /assignments, GET /assignments/current
│       ├── docsRoutes.ts       # GET /docs (Swagger UI), GET /docs/openapi.json
│       ├── healthRoutes.ts     # GET /health/live, GET /health/ready
│       ├── planRoutes.ts       # CRUD /plans
│       ├── usageRoutes.ts      # POST /usage, GET /usage (history)
│       └── userRoutes.ts       # POST/GET /users
├── docs/
│   └── openapi.ts              # Hand-maintained OpenAPI 3.1 specification
├── errors/
│   ├── AppError.ts             # Typed error classes
│   └── errorHandler.ts         # Express error middleware, HTTP status mapping
├── logging/
│   └── logger.ts               # Pino structured logger with request correlation
├── validation/
│   └── schemas.ts              # Zod input validation schemas
├── scripts/
│   ├── bootstrap.ts            # Seed system plans, create account + API key, assign Starter
│   ├── bootstrap-loadtest.ts   # Create load-test account, plans, user, API key
│   ├── loadtest.ts             # Autocannon load test script
│   └── verify-invariants.ts    # Accounting invariant checks (counters vs decision log)
├── cli/                        # Example CLI client (entry: cli/index.ts)
│   ├── index.ts                # Command dispatch + post-demo invariant step
│   ├── options.ts              # Arg parsing, help text, key resolution
│   ├── apiClient.ts            # HTTP requests, auth headers, error normalization
│   ├── output.ts               # Scenario report (PASS/FAIL checks, summary)
│   ├── commands/               # consume, usage, history
│   └── demo/                   # setup (users/plans/probe) + scenario (S1–S8)
└── test/
    ├── setup.ts                # Test database lifecycle (migrate, truncate)
    ├── utils.ts                # Test helper functions
    ├── accountRepository.test.ts # Account row mapping / soft-delete guard
    ├── assignmentPolicy.test.ts # Immediate changes, supersession, EPQ lock races, BR-13
    ├── bootstrap.test.ts       # Bootstrap integration tests
    ├── boundary.test.ts        # Quota, bigint, idempotency, plan boundary tests
    ├── docs.test.ts            # OpenAPI spec completeness + Swagger UI smoke test
    ├── monthBoundary.test.ts   # UTC month-boundary period semantics (admission time + replay)
    ├── verifyInvariants.test.ts # Verifier self-test: clean pass + seeded INV-1 mismatch detection
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
- **Secret Handling**: API key secrets never logged; only prefix + SHA-256 hash stored; comparisons are timing-safe. In Docker, the bootstrap key file lives on the `bootstrap-secrets` volume owned by `node` with mode `0600` (directory `0700`), repaired on every start by the entrypoint before it drops privileges
- **Log Redaction**: Pino redacts `authorization` / `x-api-key` / `cookie` fields anywhere in log objects
- **Parameterized Queries**: Drizzle ORM prevents SQL injection
- **Rate Limiting**: Per-IP before authentication, per-API-key after (defaults: `RATE_LIMIT_MAX` = 100 requests per `RATE_LIMIT_WINDOW_MS` = 60s, applied independently to each layer); bounded in-process store per application instance; if the store fails, requests are rejected `429` (fail-closed)
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
3. **Per-Process Rate Limiting**: Rate-limit counters are held in a bounded in-process store: they reset when the application process restarts and are **not shared between application replicas**. Each replica enforces the configured limit independently. There is no distributed rate limiting; deployments that need cross-replica request budgets must add an external shared store themselves (deliberately out of scope — the service has no optional Redis/other-store integration).
4. **No Distributed Tracing / Metrics**: Structured logs with request IDs only; no OpenTelemetry or Prometheus.
5. **Performance Baseline**: Dated measurements of the Compose stack exist ([`docs/performance/2026-10-18-compose.md`](docs/performance/2026-10-18-compose.md) for a 30-second baseline; [`docs/performance/2026-10-18-stress.md`](docs/performance/2026-10-18-stress.md) for the progressive stress campaign 10→1000 connections; [`docs/performance/results/extreme-capacity-2026-10-19/REPORT.md`](docs/performance/results/extreme-capacity-2026-10-19/REPORT.md) for the extreme-capacity campaign up to 800 connections) but are not re-run for every change; numbers describe a single development machine and are dated, environment-specific observations — not universal performance guarantees.
6. **No Independent Security Audit**: The "Security" section describes implemented controls with tests; it is not a substitute for a professional assessment (see portfolio notice above).
7. **`drizzle-orm` Advisory CVE-2026-39356 (GHSA-gpj5-g38j-94v9, high)**: Affects identifier-escaping (`sql.identifier()` / `.as()`) when untrusted input reaches identifier construction. This codebase builds identifiers only from static schema objects and internal constants (the only `sql.raw()` usage interpolates compile-time conflict-target strings; no `sql.identifier()` calls exist), which the advisory explicitly scopes out of impact. Upgrading `drizzle-orm` 0.33 → 0.45.x is a breaking-change maintenance item scheduled after this milestone, not silently ignored.

---

## Performance Baseline

Load testing was performed with Autocannon against the Docker Compose stack (app + PostgreSQL 16 in containers) on a single development machine. Results are a local baseline for the recorded environment, not a universal production capacity guarantee.

### Test Environment (2026-10-18)

- Host: Linux x86_64, 12 CPU cores, 7.9 GB RAM
- App: `node:22-alpine` in Docker Compose
- PostgreSQL 16.15 in Docker Compose (the historical stack also ran Redis 7 for rate limiting; Redis has since been removed from the project)
- Rate limit raised to `RATE_LIMIT_MAX=10000000` for the measurement window only (default is 100 req/60s per layer)
- Account-scoped authenticated `POST /usage`, `units=1`, unique idempotency key per request, pipelining 1

### Baseline Results (30s, 10 connections)

| Metric | Value |
|--------|-------|
| Requests/second (mean) | 120.40 |
| Total requests | 3,622 |
| p50 | 17 ms |
| p75 | 27 ms |
| p90 | 242 ms |
| p97.5 | 378 ms |
| p99 | 546 ms |
| Max | 922 ms |
| Mean | 82.23 ms (stddev 119.03 ms) |
| Errors / timeouts / non-2xx | 0 / 0 / 0 |

> **Note on p95**: `autocannon`'s fixed histogram does not emit a p95 value (`result.latency.p95` is `undefined`), so the loader prints only the percentiles it actually measures (`p50`, `p75`, `p90`, `p97_5`, `p99`, `max`) and the reports never interpolate a fabricated p95.

After the run the database showed 3,622 accepted / 0 rejected requests and an account counter exactly equal to the accepted sum; the invariant verifier passed for the whole database. Throughput is limited by the per-request transaction (counter lock + decision-log insert + commit); with 10 connections at ~82 ms mean latency, the observed rate matches the latency-bound prediction (≈122 req/s).

Full method, database evidence, and reproduction steps: [`docs/performance/2026-10-18-compose.md`](docs/performance/2026-10-18-compose.md). A longer progressive stress campaign (10→1000 connections, idempotency storm, multi-user contention, invariant checks before/after) is recorded in [`docs/performance/2026-10-18-stress.md`](docs/performance/2026-10-18-stress.md).

### Extreme-Capacity Campaign (2026-10-19)

A separate isolated campaign pushed the same stack to 800 concurrent connections (hot-account ladder, multi-account runs, a 10-minute soak, and recovery stages) with raw autocannon output, counter snapshots, and the reproduction scripts kept alongside the report:

- Report: [`docs/performance/results/extreme-capacity-2026-10-19/REPORT.md`](docs/performance/results/extreme-capacity-2026-10-19/REPORT.md)
- Machine-readable summary: [`docs/performance/results/extreme-capacity-2026-10-19/summary.json`](docs/performance/results/extreme-capacity-2026-10-19/summary.json)

These measurements are dated (2026-10-19) and specific to that environment (single WSL2 development machine, Compose stack, `synchronous_commit=on`). They characterize that run; they are not universal performance guarantees and are not re-run for every change.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Author

Ahmad Zaqiq — Computer Systems Engineering graduate, Palestine Polytechnic University.