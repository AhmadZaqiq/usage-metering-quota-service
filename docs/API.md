# API Reference

Interactive documentation: `GET /docs` (Swagger UI). Machine-readable spec: `GET /docs/openapi.json` (OpenAPI 3.1, hand-maintained in `src/docs/openapi.ts`; the `docs.test.ts` smoke test fails if routers and spec drift apart).

## Authentication

All protected endpoints require `Authorization: Bearer <api_key>` header.
API key format: `<prefix>.<secret>` (prefix stored plain, secret hashed with SHA-256)

## Endpoints

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health/live` | No | Process liveness |
| `GET` | `/health/ready` | No | Database readiness |

### API Keys

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api-keys` | Yes | Create key (returns full key once) |
| `GET` | `/api-keys` | Yes | List keys (id, prefix, name, revoked, lastUsedAt, created) |
| `DELETE` | `/api-keys/:id` | Yes | Revoke key |

### Plans

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/plans` | Yes | Create custom plan |
| `GET` | `/plans` | Yes | List plans (system + own custom) |
| `GET` | `/plans/:id` | Yes | Get plan details |
| `PATCH` | `/plans/:id` | Yes | Update own custom plan |
| `DELETE` | `/plans/:id` | Yes | Soft delete own custom plan (409 if currently or pending assigned) |

System plans (Starter, Pro, Basic, Premium) are seeded read-only for every tenant: `PATCH`/`DELETE` on an ownerless plan returns `403`. Exact seeded values: **Starter 10000/100 · Pro 1000000/1000 · Basic 500/20 · Premium 5000/200** (`monthlyAllowance`/`maxUnitsPerRequest`).

### Assignments

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/assignments` | Yes | Assign plan to account/user |
| `GET` | `/assignments` | Yes | List all assignments (current + history) |
| `GET` | `/assignments/current` | Yes | Get current assignments |

#### Assignment timing

Plan changes follow an **immediate** model: the new assignment takes effect on the very next usage request.

- `effectiveFrom` is optional. It is honored only for the **first** assignment to a subject (no current assignment). When a current assignment exists, the change starts **now** (stamped after locks are acquired), regardless of the client-provided value.
- Switching plans closes the current assignment at the replacement's start (half-open intervals: `effectiveTo` equals the successor's `effectiveFrom`), so exactly one assignment is in effect at any instant. History rows are never deleted.
- A newer change also **supersedes** any not-yet-effective (pending) row for the same subject; the superseded row becomes a zero-width audit artifact (`effectiveTo = effectiveFrom`) and never covers any instant.
- Usage counters are **never reset** by a plan change. Remaining quota = effective plan's allowance − usage already consumed this UTC month.
- Lowering an allowance **below already-consumed usage** clamps remaining to `0` (never negative); further requests at that level are rejected (`account_quota_exceeded` / `user_quota_exceeded`) until the allowance is raised again. Raising applies immediately.
- Assignment responses return full ISO-8601 instants for `effectiveFrom`/`effectiveTo`.
- Soft-deleting or deactivating a plan that is current or pending for any subject returns **409 Conflict**. Reassign first.

### Users

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/users` | Yes | Create user (external client_user_id) |
| `GET` | `/users` | Yes | List users in account |

### Usage

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/usage` | Yes | Submit usage request |
| `GET` | `/usage` | Yes | Usage decision history (paginated: `page`, `limit`; optional `userId` filter — `clientUserId` resolved in the authenticated account, `404` if unknown) |

## Usage Request

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

`requestId` is the public idempotency identity (replay-safe retry key). It maps to the `usage_requests.idempotency_key` storage column and is unrelated to the `X-Request-Id` correlation header. Sending both `requestId` and `idempotencyKey` is a `400`.

## Usage Response (Accepted)

```json
{
  "decision": "accepted",
  "accountRemaining": "995",
  "userRemaining": "495",
  "periodStart": "2026-10-01"
}
```

## Usage Response (Rejected)

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

`limitScope` identifies which per-request cap rejected the request and is **not persisted**, so an idempotent replay of a stored rejection omits it rather than re-evaluating quota:

| Value | Meaning |
|-------|---------|
| `global` | The request exceeded the server-wide `MAX_UNITS_PER_REQUEST` limit |
| `account` | The request exceeded the account plan's `maxUnitsPerRequest` (also used when caps are equal, or when no user plan applies) |
| `user` | The request exceeded the user plan's `maxUnitsPerRequest`, which was the tighter of the two caps |

## Quota Evaluation Order

For each request, the service evaluates (in order):

1. **Per-request maximum**: `units ≤ min(account_plan.max_units_per_request, user_plan?.max_units_per_request)`
2. **Account quota**: `units ≤ account_plan.monthly_allowance - account_counter`
3. **User quota** (if applicable): `units ≤ user_plan.monthly_allowance - user_counter`

Missing plan configuration is a **state conflict**, not a quota outcome:

- No effective **account** plan → `409 CONFLICT` (`No active account plan assigned`)
- `userId` supplied but no effective **user** plan → `409 CONFLICT` (`No active user plan assigned for user`) — no silent account-only fallback
- Account-scoped requests (no `userId`) intentionally use account quota only

Rejected requests never consume quota: their decision is recorded in the `usage_requests` decision log (for audit and idempotent replay), but the counters are not incremented. Validation failures (`400`) are rejected before the service runs and persist nothing.

All periods are UTC calendar months (`periodStart` = first day of the month, e.g. `2026-10-01`), computed once per request from the admission clock.

## Error Responses

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
