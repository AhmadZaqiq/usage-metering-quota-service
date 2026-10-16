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
- **Rate Limiting**: In-memory rate limiting (per IP for unauthenticated, per key prefix for authenticated)
- **Redis-backed Distributed Rate Limiting**: Optional Redis store for multi-instance deployments (falls back to in-memory)
- **Docker Support**: Docker Compose for local development with PostgreSQL 16

---

## Architecture

### Dependency Direction

```mermaid
graph TD
    A[HTTP Routes / Controllers] --> B[Application Services / Use Cases]
    B --> C[Domain Rules & Interfaces]
    C --> D[Repository Contracts]
    D --> E[PostgreSQL / Drizzle Implementations]
    
    F[Cross-cutting: Config, Logging, Middleware, Validation, Errors, Health, Rate Limiting, OpenAPI] -.-> A
    F -.-> B
    F -.-> E
```

### Module Responsibilities

| Module | Responsibility |
|--------|----------------|
| `auth` | API key generation, verification, revocation, middleware |
| `plans` | Plan CRUD, ownership, activation, custom plans |
| `assignments` | Assignment lifecycle, effective dates, overlap prevention |
| `usage` | Quota evaluation, counter persistence, transactional processing, idempotency |
| `health` | Liveness and readiness checks |
| `config` | Environment validation (Zod) |
| `logging` | Structured Pino logging with request correlation |
| `errors` | Typed error classes and HTTP error mapping |
| `validation` | Zod schemas for all inputs |

### Key Design Decisions

- **Pure Quota Evaluator**: `quotaEvaluator.ts` is a pure function with no DB/HTTP dependencies
- **Nullable user_id**: `NULL` user_id represents account-level counters (avoids partial index ORM issues; partial unique indexes enforce uniqueness per NULL vs non-NULL)
- **Idempotency in `usage_requests`**: No separate table; unique constraint on `(account_id, idempotency_key)` + request hash
- **Next-Month Plan Changes**: Plan changes take effect at next UTC month boundary to prevent mid-month quota gaming
- **PostgreSQL Constraints as Source of Truth**: Exclusion constraints, triggers, partial unique indexes enforce invariants

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

- **Partial Unique Indexes**: One current account-level assignment per account, one current user-level assignment per user
- **Exclusion Constraint**: Prevents overlapping assignment periods for same subject
- **Trigger**: Enforces plan-type compatibility (account plan ↔ account assignment, user plan ↔ user assignment)
- **Composite FK**: `(account_id, user_id) → users(account_id, id)` guarantees user belongs to account
- **Check Constraints**: Positive allowances, positive units, non-negative counters

---

## Quota Evaluation

### Monthly Periods
- All periods calculated in UTC using `date_trunc('month', now() AT TIME ZONE 'UTC')`
- Period represented as `DATE` (first day of month, e.g., `2026-10-01`)
- Computed once per request and passed through transaction

### Decision Logic
For each request, the service evaluates (in order):

1. **Per-request maximum**: `units ≤ min(account_plan.max_units_per_request, user_plan?.max_units_per_request)`
2. **Account quota**: `units ≤ account_plan.monthly_allowance - account_counter`
3. **User quota** (if applicable): `units ≤ user_plan.monthly_allowance - user_counter`

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
- Client supplies `idempotencyKey` (1-255 chars)
- Server computes SHA-256 hash of canonical request: `{ accountId, userId, units }`
- **Same key + same hash** → returns original decision (no quota consumed)
- **Same key + different hash** → `409 Conflict`
- Unique constraint on `(account_id, idempotency_key)` prevents duplicate processing

### Concurrency Strategy
- **Isolation Level**: `READ COMMITTED` (PostgreSQL default)
- **Lock Order**: Account counter → User counter (consistent ordering prevents deadlocks)
- **Counter Creation**: Atomic `INSERT ... ON CONFLICT DO UPDATE SET counter = counter` (no-op update acquires lock)
- **Retry Policy**: 3 retries with exponential backoff (50/100/200ms) on deadlock (`40P01`) and serialization failure (`40001`)

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
| `DELETE` | `/plans/:id` | Yes | Soft delete own custom plan |

#### Assignments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/assignments` | Yes | Assign plan to account/user |
| `GET` | `/assignments` | Yes | List all assignments (current + history) |
| `GET` | `/assignments/current` | Yes | Get current assignments |

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
| 400 | `VALIDATION_ERROR` | Invalid request body/params |
| 401 | `AUTHENTICATION_FAILED` | Missing/invalid API key |
| 403 | `AUTHORIZATION_FAILED` | Revoked key, inactive/deleted account |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `CONFLICT` | Idempotency key reused with different payload |
| 429 | `RATE_LIMITED` | Rate limit exceeded |
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

```bash
# Start PostgreSQL and app
docker compose up -d

# Run migrations (first time or after schema changes)
docker compose exec app npx tsx --env-file=.env src/db/migrate.ts

# Create initial account and API key
docker compose exec app npx tsx --env-file=.env src/scripts/bootstrap.ts
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
├── app.ts                      # Express app factory
├── config/
│   └── index.ts                # Zod-validated environment
├── db/
│   ├── client.ts               # Drizzle client, pool, transaction helper
│   ├── schema/                 # 7 table definitions
│   ├── migrations/             # Drizzle-generated migrations
│   └── sql/                    # Custom SQL (constraints, triggers)
├── modules/
│   ├── auth/                   # API key lifecycle, middleware
│   ├── plans/                  # Plan + assignment services
│   ├── rate-limiter/           # Rate limiting (in-memory + Redis)
│   ├── usage/                  # Quota evaluator, counters, usage service
│   └── health/                 # Health checks
├── routes/                     # Express route handlers
├── validation/                 # Zod schemas
├── errors/                     # Typed error classes + handler
├── logging/                    # Pino logger factory
├── utils/                      # Hash, idempotency, date utilities
└── scripts/                    # Bootstrap, example client, load test
```

---

## Security

- **No Client-Trust**: Account ID derived from authenticated API key only
- **Secret Handling**: API key secrets never logged; only prefix stored in plaintext
- **Parameterized Queries**: Drizzle ORM prevents SQL injection
- **Rate Limiting**: In-memory (single-instance); optional Redis-backed distributed limiting for multi-instance
- **Request Size Limit**: 64KB body limit
- **CORS**: Not configured; API key authentication provides primary access control. Configure CORS in `app.ts` if browser-based clients are needed.
- **HTTPS**: Terminates at reverse proxy in production (not included)
- **Proxy Trust**: `TRUST_PROXY=true` only when behind a trusted reverse proxy; otherwise forwarded headers (e.g., `X-Forwarded-For`) could be spoofed by clients
- **Input Validation**: Zod schemas at all boundaries

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

No license specified. All rights reserved.

---

## Author

Ahmad Zaqiq — Computer Systems Engineering graduate, Palestine Polytechnic University.