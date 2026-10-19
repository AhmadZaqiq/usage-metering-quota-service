# Usage Metering & Quota Service

A professional, backend-only Usage Metering & Quota Service built with TypeScript, Node.js, Express, and PostgreSQL. This service accepts authenticated usage requests, evaluates account-level and user-level quotas, records decisions, and ensures usage cannot be consumed more than once through retries or concurrent requests.

> **Portfolio Project Notice**: This is a learning and portfolio project demonstrating backend engineering practices. Performance and security guarantees have not been independently verified. Known issues are documented below.

---

## Key Guarantees

- **API-Key Authentication**: SHA-256-hashed secrets, prefix identification, revocation; all operations scoped to the authenticated account — no client-supplied account IDs are trusted
- **Tenant Isolation**: Composite foreign keys guarantee `(account_id, user_id)` pairing even if application code is buggy
- **Seeded System Plans**: Starter/Pro (account) and Basic/Premium (user) are idempotently seeded with exact values and are read-only for every tenant; accounts fully manage their own custom plans (10000/100 · 1000000/1000 · 500/20 · 5000/200)
- **Plan Assignments**: Account- and user-level assignments with effective dates, history, overlap exclusion constraints, and an immediate-change model (the next request uses the new plan; counters are never reset)
- **Monthly Quota Periods**: UTC calendar months; the admission timestamp is sampled from the database clock *after* the account row lock is granted, so a request queued across a month boundary is charged to the month in which it is admitted
- **Idempotency**: `requestId` (public contract name; maps to `usage_requests.idempotency_key`) with deterministic request hashing — same key + same payload replays the original committed decision; same key + different payload is `409`
- **Concurrency Safety**: Counter rows serialized by an upsert row lock held to commit; consistent lock ordering (account row → account counter → user counter → API-key row) prevents deadlocks; deadlock/serialization failures retried 3×
- **Fail-Closed Plan Requirements**: A user-scoped request with no effective user plan is `409` — never a silent account-only fallback
- **Per-Request Breach Scope**: `max_per_request_exceeded` rejections report which cap bound (`global` / `account` / `user`)
- **Rate Limiting**: Per-IP before authentication and per-API-key after, over a bounded in-process store; if the store fails, requests are rejected `429` (fail-closed)
- **Structured Logging, Health, Docs**: Pino request/decision logs with correlation; `/health/live` + `/health/ready`; OpenAPI 3.1 at `/docs/openapi.json` and Swagger UI at `/docs`
- **Docker Support**: Multi-stage image; the container starts as root only to repair the secrets volume's ownership, then drops to the unprivileged `node` user before serving traffic
- **Example CLI + Invariant Verifier**: A demo client walks the full lifecycle end to end, an interactive company simulator drives 12 guided scenarios over the same API, and `verify-invariants` cross-checks counters against the decision log and exits non-zero on any mismatch

Full endpoint contracts: [`docs/API.md`](docs/API.md). Architecture, schema, invariants, and concurrency scenarios: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 20+ (for local development without Docker)
- Git

### Environment Configuration

Copy `.env.example` to `.env` and adjust. Only one variable is required; everything else has a working default:

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

The image is multi-stage (build → runtime, production dependencies only). `docker-entrypoint.sh` repairs ownership of the `/run/secrets` volume, drops from root to the unprivileged `node` user, then runs migrations, bootstrap, and the server in that order on every start:

```bash
# If a local PostgreSQL already occupies port 5432, publish elsewhere:
#   POSTGRES_PORT=5434 docker compose up -d --build
docker compose up -d --build

# On the FIRST start, the logs contain the generated key — save it:
docker compose logs app | grep -A1 "BOOTSTRAP API KEY"
```

Migrations are forward-only and idempotent (advisory-locked), so restarts are safe. The key is persisted to the `bootstrap-secrets` volume at `/run/secrets/api-key` (owned by `node`, mode `0600`; directory `0700`) and reused on later restarts; it is never re-printed. If the key file is missing but the key row survives, bootstrap rotates to a new key: it writes the replacement first and only revokes the old key after the write succeeds. To rerun bootstrap manually:

```bash
docker compose exec app node dist/scripts/bootstrap.js
```

The `client` service runs the demo CLI against `http://app:3000` using the stored key and then verifies accounting invariants:

```bash
docker compose run --rm client
```

#### Reconciling databases seeded before the exact-value catalog

`ensureSystemPlans` only inserts missing rows — it never updates an existing plan. A database seeded with older allowances keeps them until an operator reconciles deliberately (document-only guidance; nothing in this repository executes it automatically):

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

`bootstrap.test.ts` asserts the exact seeded values on a fresh test database, so a clean install is covered by CI without any reconciliation step.

### Local Development (without Docker)

```bash
npm install
# Start PostgreSQL separately (DATABASE_URL in .env must point at it)
npm run db:migrate
npm run dev
```

### Minimal API Example

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

Request/response bodies, error codes, and evaluation order: [`docs/API.md`](docs/API.md).

---

## Architecture (Brief)

Five layers with one dependency direction; PostgreSQL is the source of truth:

```
Presentation (routes, middleware)
    → Application (use-case services, transaction boundaries)
        → Domain (pure: quotaEvaluator, idempotency, date, hash)
    → Infrastructure (repositories, API-key verification, rate limiter)
        → Database (Drizzle + raw SQL, migrations, constraints)
```

Cross-cutting modules (config, logging, errors, validation) are imported by any layer that needs them; no circular dependencies are permitted. Key design decisions — pure quota evaluator, `NULL` `user_id` for account counters, idempotency stored in `usage_requests` (no separate table), immediate plan changes stamped after locks, fail-closed missing-plan checks, `READ COMMITTED` + explicit auditable locks — are explained in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), together with the full schema, custom SQL constraints, the `POST /usage` request flow, the invariant table, and the concurrency-scenario matrix.

### Idempotency & Concurrency (Summary)

- Client supplies `requestId` (1–255 chars); `idempotencyKey` is a deprecated alias (sending both is `400`). Keys are unique per account for the life of the account, not per month: a replay returns the original committed decision — including its original `periodStart` — and never consumes current quota.
- The server hashes `{ accountId, userId, units }`; same key + same hash replays, same key + different hash is `409`, enforced by the unique constraint on `(account_id, idempotency_key)`.
- Usage lock order: accounts row (admission lock) → account counter → user counter → API-key row. Counters are created by atomic `INSERT ... ON CONFLICT DO UPDATE` (the no-op update takes the lock). Assignment lock order: target plan row → subject's assignment rows; a waiter re-checks `deleted_at`/`is_active` under READ COMMITTED (EvalPlanQual) and fails with `404`/`409` instead of using a stale row.
- Deadlock (`40P01`) and serialization (`40001`) failures retry 3× with backoff (50/100/200 ms).

---

## CLI Usage

`src/cli/` is an HTTP-only example tenant client with five commands:

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

# simulate: interactive company simulator — idempotent setup of a fictional
# tenant (users, plans, assignments), a menu (dashboard, users & balances,
# consume, plans, assignments, paginated history), and 12 guided scenarios
# (quota accept/reject with limitScope, shared account pool, per-request cap,
# plan changes, idempotent replay and 409 conflict, validation/auth errors).
# All state is re-read from the service; on exit it offers to restore the
# account plan the session replaced. Reads menu choices from stdin, so it can
# be scripted with piped input (EOF exits cleanly).
npm run client -- simulate -k <API_KEY>

npm run client -- --help
```

Inside Docker Compose the demo and the simulator run as one-shot services.
The client service sets `BASE_URL=http://app:3000` in its environment (the
`-u` flag still takes precedence when you need a different target):

```bash
docker compose run --rm client               # demo walkthrough — URL from the
                                              # client service BASE_URL
docker compose run -i --rm client node dist/cli/index.js simulate
                                              # interactive simulator — keep stdin attached
```

The full API key is never printed; only the public prefix is shown. Exit codes: `0` success, `1` failure.

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
| `npm run client` | Run example CLI client (demo walkthrough by default; `simulate` for the interactive company simulator) |
| `npm run verify:invariants` | Cross-check usage counters against the decision log |

### Testing

```bash
npm test                                  # full suite (needs the compose test database)
npm run test:coverage                     # with coverage
DATABASE_URL=postgresql://app:app_secret@localhost:5432/usage_metering npm run verify:all
```

Tests use real PostgreSQL (test database via Docker Compose); there are no mocks for database behavior. The suite covers unit tests (pure domain), HTTP integration through the real Express pipeline (auth, validation, usage decisions, rate limiting), concurrency tests, month-boundary tests, and direct-SQL constraint proofs. As of the latest run: **21 test files, 226 tests, all passing**.

After running the demo or a load test, verify that counters still match the decision log:

```bash
docker compose run --rm app node dist/scripts/verify-invariants.js
# or locally against a configured DATABASE_URL:
npm run verify:invariants
```

The verifier checks account/user counters against accepted usage, non-negative stored remainings, UTC period alignment, tenant pairing, idempotency-key uniqueness, and rejected-request accounting (INV-1…INV-8), and exits non-zero on any violation.

### Compose Profiles (tests / app-test / loadtest)

Plain `docker compose up -d` is unchanged. Three profile-gated services cover Docker-native verification and load workflows:

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

### Load Testing (direct)

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

---

## Project Structure

```text
Dockerfile / docker-entrypoint.sh   # Multi-stage build; entrypoint drops root → node
src/
├── main.ts                         # Entry point, graceful shutdown
├── app.ts                          # Express app factory, middleware wiring
├── config/                         # Zod-validated environment
├── domain/                         # Pure rules: quotaEvaluator, idempotency, date, hash, pgError
├── application/                    # Use cases: auth, plans, usage, users, health
├── infrastructure/                 # Repositories, API-key verification, rate limiter
├── presentation/                   # Routes + middleware (auth, asyncHandler)
├── validation/                     # Zod input schemas
├── errors/                         # AppError + HTTP error mapping
├── logging/                        # Pino structured logger
├── db/                             # Client/pool, schema, migrations, custom SQL
├── docs/openapi.ts                 # Hand-maintained OpenAPI 3.1 spec
├── scripts/                        # bootstrap, bootstrap-loadtest, loadtest, verify-invariants
├── cli/                            # Example CLI: index, options, apiClient, output,
│                                   # commands/ (consume, usage, history, simulate),
│                                   # demo/ (setup, scenario), simulate/ (menu, setup,
│                                   # actions, scenarios: 12 guided scenarios)
└── test/                           # 23 Vitest suites (unit + integration + concurrency)
docs/
├── API.md                          # Endpoint contracts, request/response/error shapes
├── ARCHITECTURE.md                 # Layers, schema, invariants, concurrency scenarios, decisions
├── REQUIREMENTS-COVERAGE.md        # Requirement → code → test map
└── performance/                    # Dated load-test reports and evidence (see below)
```

---

## Security

- No client-trust of account identity; secrets are SHA-256-hashed, compared timing-safely, and never logged (only the prefix). In Docker, the bootstrap key file lives on the `bootstrap-secrets` volume owned by `node` with mode `0600`
- Pino redacts `authorization` / `x-api-key` / `cookie` fields; parameterized queries via Drizzle
- 64 KB body limit; server `requestTimeout` 15 s, `headersTimeout` 10 s; pool `statement_timeout` 15 s
- CORS is not configured (API-key auth is the access control); HTTPS terminates at a reverse proxy in production; set `TRUST_PROXY=true` only behind a trusted proxy
- Rate limiting (per-IP + per-API-key, fail-closed), Zod validation at all boundaries, composite tenant FKs as the last line of defense

These controls have not been independently audited.

---

## Performance Baseline

Load testing was performed with Autocannon against the Docker Compose stack (app + PostgreSQL 16 in containers) on a single development machine. Results are a local baseline for the recorded environment, not a universal production capacity guarantee.

**Test environment (2026-10-18):** Linux x86_64, 12 CPU cores, 7.9 GB RAM; `node:22-alpine` and `postgres:16-alpine` in Docker Compose (the historical stack also ran Redis 7 for rate limiting; Redis has since been removed from the project); rate limit raised to `RATE_LIMIT_MAX=10000000` for the measurement window only (default is 100 req/60 s per layer); account-scoped authenticated `POST /usage`, `units=1`, unique idempotency key per request, pipelining 1.

**Baseline (30 s, 10 connections):** 120.40 req/s mean (3,622 total), p50 17 ms, p90 242 ms, p99 546 ms, 0 errors / 0 timeouts / 0 non-2xx. After the run the database showed 3,622 accepted / 0 rejected and an account counter exactly equal to the accepted sum; the invariant verifier passed for the whole database. (`autocannon` does not emit a p95; reports never interpolate one.)

A progressive stress campaign (10→1000 connections, idempotency storms, multi-user contention, invariant checks before/after) and an isolated extreme-capacity campaign (up to 800 connections, 10-minute soak, boundary-race proofs: exactly N accepted for N remaining) are recorded under [`docs/performance/`](docs/performance/README.md):

- 30 s baseline + method: [`docs/performance/2026-10-18-compose.md`](docs/performance/2026-10-18-compose.md)
- Progressive stress: [`docs/performance/2026-10-18-stress.md`](docs/performance/2026-10-18-stress.md)
- Extreme-capacity report: [`docs/performance/results/extreme-capacity-2026-10-19/REPORT.md`](docs/performance/results/extreme-capacity-2026-10-19/REPORT.md) · machine-readable [`summary.json`](docs/performance/results/extreme-capacity-2026-10-19/summary.json)

These measurements are dated and specific to that environment (single WSL2 development machine, Compose stack, `synchronous_commit=on`). They characterize those runs; they are not re-run for every change.

---

## Known Limitations & Deferred Findings

Honest status of items that are deliberately not done:

1. **Idempotency Key Retention**: Keys are unique per account indefinitely; no TTL/archival — the `usage_requests` table grows without bound. A retention job is out of scope for this milestone.
2. **`int8` Type Parser (audit DB-08)**: PostgreSQL `BIGINT` values are coerced to native `bigint` at repository mapping boundaries (and via Drizzle `mode: "bigint"`) instead of installing a global `pg` type parser. A global parser would also affect health checks, migrations, and any future raw client usage; the localized approach is explicit and test-covered.
3. **Per-Process Rate Limiting**: Rate-limit counters are held in a bounded in-process store: they reset when the application process restarts and are **not shared between application replicas**. Each replica enforces the configured limit independently. There is no distributed rate limiting; deployments that need cross-replica request budgets must add an external shared store themselves (deliberately out of scope — the service has no optional Redis/other-store integration).
4. **No Distributed Tracing / Metrics**: Structured logs with request IDs only; no OpenTelemetry or Prometheus.
5. **Performance Baseline**: Dated measurements of the Compose stack exist (linked above) but are not re-run for every change; numbers describe a single development machine and are dated, environment-specific observations — not universal performance guarantees.
6. **No Independent Security Audit**: The "Security" section describes implemented controls with tests; it is not a substitute for a professional assessment (see portfolio notice above).
7. **`drizzle-orm` Advisory CVE-2026-39356 (GHSA-gpj5-g38j-94v9, high)**: Affects identifier-escaping (`sql.identifier()` / `.as()`) when untrusted input reaches identifier construction. This codebase builds identifiers only from static schema objects and internal constants (the only `sql.raw()` usage interpolates compile-time conflict-target strings; no `sql.identifier()` calls exist), which the advisory explicitly scopes out of impact. Upgrading `drizzle-orm` 0.33 → 0.45.x is a breaking-change maintenance item scheduled after this milestone, not silently ignored.

---

## License

MIT.

## Author

Ahmad Zaqiq — [AhmadZaqiq](https://github.com/AhmadZaqiq)
