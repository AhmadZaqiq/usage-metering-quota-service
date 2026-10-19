/**
 * Hand-maintained OpenAPI 3.1 specification.
 *
 * Coverage: every HTTP operation the service exposes. The smoke test in
 * src/test/docs.test.ts fails if this list and the mounted routers drift
 * apart. Request-body schemas mirror src/validation/schemas.ts; response
 * shapes mirror the JSON produced by the presentation routes (bigint values
 * serialized as digit-strings, dates as ISO-8601).
 */
export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Usage Metering & Quota Service",
    version: "1.0.0",
    description:
      "Backend-only usage metering and quota service. Authenticate every request with an API key issued by the service. Quota periods are UTC calendar months; counters are serialized per account/user by database row locks and protected by idempotency keys.",
  },
  servers: [{ url: "/", description: "This host" }],
  tags: [
    { name: "Health", description: "Liveness and readiness probes (no authentication)" },
    { name: "Docs", description: "This specification and the Swagger UI (no authentication)" },
    { name: "Usage", description: "Meter usage against monthly quotas" },
    { name: "API Keys", description: "Issue, list, and revoke API keys" },
    { name: "Plans", description: "Manage account-owned and system plans" },
    { name: "Assignments", description: "Assign plans to accounts and users" },
    { name: "Users", description: "Manage tenant-scoped users" },
  ],
  components: {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "Full API key returned once at creation: Authorization: Bearer <prefix>.<secret>",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                enum: [
                  "VALIDATION_ERROR",
                  "AUTHENTICATION_FAILED",
                  "AUTHORIZATION_FAILED",
                  "NOT_FOUND",
                  "CONFLICT",
                  "IDEMPOTENCY_CONFLICT",
                  "RATE_LIMITED",
                  "PAYLOAD_TOO_LARGE",
                  "INTERNAL_ERROR",
                  "TRANSACTION_CONFLICT",
                  "DATABASE_CAPACITY_EXCEEDED",
                ],
              },
              message: { type: "string" },
              details: { type: "object", additionalProperties: true },
            },
          },
        },
      },
      PositiveIntegerString: {
        type: "string",
        pattern: "^\\d+$",
        description: "Non-negative integer serialized as a string (database BIGINT)",
      },
      Plan: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string", maxLength: 100 },
          type: { type: "string", enum: ["account", "user"] },
          ownerAccountId: {
            type: ["integer", "null"],
            description: "Null for system plans; the owning account for custom plans",
          },
          monthlyAllowance: { $ref: "#/components/schemas/PositiveIntegerString" },
          maxUnitsPerRequest: { $ref: "#/components/schemas/PositiveIntegerString" },
          isActive: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Assignment: {
        type: "object",
        properties: {
          id: { type: "integer" },
          accountId: { type: "integer" },
          userId: { type: ["integer", "null"], description: "Null for account-level assignments" },
          planId: { type: "integer" },
          planName: { type: "string" },
          effectiveFrom: { type: "string", format: "date-time" },
          effectiveTo: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          isCurrent: { type: "boolean" },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "integer" },
          clientUserId: { type: "string", maxLength: 255 },
          isActive: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      UsageDecision: {
        type: "object",
        required: ["decision", "accountRemaining", "periodStart"],
        properties: {
          decision: { type: "string", enum: ["accepted", "rejected"] },
          accountRemaining: { $ref: "#/components/schemas/PositiveIntegerString" },
          userRemaining: {
            $ref: "#/components/schemas/PositiveIntegerString",
            description: "Present only when the request carried a userId",
          },
          periodStart: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            description: "First day of the UTC month the request was admitted to",
          },
          rejectionReason: {
            type: "string",
            enum: ["account_quota_exceeded", "user_quota_exceeded", "max_per_request_exceeded"],
            description: "Present only on rejected decisions",
          },
          limitScope: {
            type: "string",
            enum: ["global", "account", "user"],
            description:
              "Present only when rejectionReason is max_per_request_exceeded and only on a live evaluation (not an idempotent replay)",
          },
        },
      },
    },
    parameters: {
      IdPath: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", pattern: "^\\d+$" },
        description: "Numeric resource id",
      },
    },
    responses: {
      BadRequest: {
        description: "Validation error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Unauthorized: {
        description: "Missing or invalid API key",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Forbidden: {
        description: "Cross-tenant access or ownership violation",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      NotFound: {
        description: "Resource not found or not owned by this account",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Conflict: {
        description: "Business conflict (idempotency reuse, missing plan, overlapping assignment)",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      PayloadTooLarge: {
        description: "JSON request body above the 64 KB size limit",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      TooManyRequests: {
        description: "Rate limit exceeded (per-IP or per-API-key); includes Retry-After and X-RateLimit-* headers",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      InternalError: {
        description: "Unexpected server error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      ServiceUnavailable: {
        description:
          "Temporary overload: either a deadlock or serialization failure survived all transaction retries (TRANSACTION_CONFLICT), or the database connection pool could not be acquired within its timeout (DATABASE_CAPACITY_EXCEEDED, includes Retry-After). Safe to retry the request; idempotency keys make retries safe.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
    headers: {
      "X-Request-Id": {
        description: "Correlation id echoed on every response",
        schema: { type: "string" },
      },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/health/live": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe",
        security: [],
        responses: {
          "200": {
            description: "Process is alive",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", const: "ok" } },
                },
              },
            },
          },
        },
      },
    },
    "/health/ready": {
      get: {
        tags: ["Health"],
        summary: "Readiness probe (checks database)",
        security: [],
        responses: {
          "200": {
            description: "Dependencies healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    checks: {
                      type: "object",
                      properties: {
                        database: {
                          type: "object",
                          properties: {
                            healthy: { type: "boolean" },
                            latencyMs: { type: "number" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "503": {
            description: "Dependency unhealthy",
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
        },
      },
    },
    "/docs": {
      get: {
        tags: ["Docs"],
        summary: "Swagger UI",
        description: "Redirects to /docs/",
        security: [],
        responses: {
          "301": {
            description: "Redirect to /docs/",
            headers: { Location: { schema: { type: "string" } } },
          },
          "200": {
            description: "Interactive API documentation",
            content: { "text/html": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/docs/openapi.json": {
      get: {
        tags: ["Docs"],
        summary: "This specification as JSON",
        security: [],
        responses: {
          "200": {
            description: "OpenAPI 3.1 document",
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
        },
      },
    },
    "/usage": {
      post: {
        tags: ["Usage"],
        summary: "Meter one usage request",
        description:
          "Evaluates the request against account and user monthly quotas in a single transaction. Reuse a requestId to retry safely: the original committed decision is replayed; the same key with a different payload is a 409. The idempotencyKey field is accepted as a deprecated alias for requestId.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["units", "requestId"],
                properties: {
                  userId: {
                    type: "string",
                    maxLength: 255,
                    description: "Optional; when present, user-level quota also applies",
                  },
                  units: {
                    type: "string",
                    pattern: "^\\d+$",
                    description: "Positive integer units as a string (1..MAX_UNITS_PER_REQUEST)",
                  },
                  requestId: {
                    type: "string",
                    minLength: 1,
                    maxLength: 255,
                    description: "Client-chosen idempotency key; replay-safe retries use the same value",
                  },
                  idempotencyKey: {
                    type: "string",
                    minLength: 1,
                    maxLength: 255,
                    deprecated: true,
                    description: "Deprecated alias for requestId; sending both fields is a 400",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Decision recorded (accepted or rejected — both are HTTP 200)",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/UsageDecision" } },
            },
            headers: { "X-Request-Id": { $ref: "#/components/headers/X-Request-Id" } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "409": { $ref: "#/components/responses/Conflict" },
          "413": { $ref: "#/components/responses/PayloadTooLarge" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
          "500": { $ref: "#/components/responses/InternalError" },
          "503": { $ref: "#/components/responses/ServiceUnavailable" },
        },
      },
      get: {
        tags: ["Usage"],
        summary: "Paginated usage-request history",
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", minimum: 1, default: 1 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          {
            name: "userId",
            in: "query",
            description:
              "Optional clientUserId filter, resolved within the authenticated account; unknown users are 404",
            schema: { type: "string", minLength: 1, maxLength: 255 },
          },
        ],
        responses: {
          "200": {
            description: "History page (newest first)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          requestId: {
                            type: "string",
                            description: "The idempotency key (storage column usage_requests.idempotency_key)",
                          },
                          userId: { type: "string", nullable: true },
                          units: { type: "string" },
                          decision: { type: "string", enum: ["accepted", "rejected"] },
                          rejectionReason: { type: "string", nullable: true },
                          periodStart: { type: "string", format: "date" },
                          accountRemaining: { type: "string", nullable: true },
                          userRemaining: { type: "string", nullable: true },
                          createdAt: { type: "string", format: "date-time" },
                        },
                        required: ["id", "requestId", "units", "decision", "periodStart", "createdAt"],
                      },
                    },
                    total: { type: "integer" },
                    page: { type: "integer" },
                    limit: { type: "integer" },
                    totalPages: { type: "integer" },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
    "/api-keys": {
      post: {
        tags: ["API Keys"],
        summary: "Create an API key",
        description: "The full key (prefix.secret) is returned exactly once and never stored in plaintext.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string", maxLength: 100 } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Key created; store the full key now — it cannot be retrieved again",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    prefix: { type: "string" },
                    key: { type: "string", description: "Full key — shown only in this response" },
                    name: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "413": { $ref: "#/components/responses/PayloadTooLarge" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
      get: {
        tags: ["API Keys"],
        summary: "List API keys",
        responses: {
          "200": {
            description: "Keys for this account (never includes secrets)",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      prefix: { type: "string" },
                      name: { type: ["string", "null"] },
                      isRevoked: { type: "boolean" },
                      lastUsedAt: { type: ["string", "null"], format: "date-time" },
                      createdAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
    "/api-keys/{id}": {
      delete: {
        tags: ["API Keys"],
        summary: "Revoke an API key",
        security: [{ apiKey: [] }],
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "204": { description: "Key revoked (idempotent)" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
    "/plans": {
      post: {
        tags: ["Plans"],
        summary: "Create an account-owned plan",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "type", "monthlyAllowance", "maxUnitsPerRequest"],
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 100 },
                  type: { type: "string", enum: ["account", "user"] },
                  monthlyAllowance: { type: "string", pattern: "^\\d+$" },
                  maxUnitsPerRequest: { type: "string", pattern: "^\\d+$" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Plan created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Plan" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "409": { $ref: "#/components/responses/Conflict" },
          "413": { $ref: "#/components/responses/PayloadTooLarge" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
      get: {
        tags: ["Plans"],
        summary: "List plans visible to this account",
        responses: {
          "200": {
            description: "System plans plus this account's custom plans",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Plan" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
    "/plans/{id}": {
      get: {
        tags: ["Plans"],
        summary: "Get one plan",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Plan found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Plan" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
      patch: {
        tags: ["Plans"],
        summary: "Update a plan",
        description: "Cannot change plan type. Amount changes apply prospectively; history is never rewritten.",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 100 },
                  monthlyAllowance: { type: "string", pattern: "^\\d+$" },
                  maxUnitsPerRequest: { type: "string", pattern: "^\\d+$" },
                  isActive: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Plan updated",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Plan" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
          "413": { $ref: "#/components/responses/PayloadTooLarge" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
      delete: {
        tags: ["Plans"],
        summary: "Soft-delete a plan",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "204": { description: "Plan soft-deleted" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
    "/assignments": {
      post: {
        tags: ["Assignments"],
        summary: "Assign a plan to this account or one of its users",
        description:
          "Omit userId for an account-level assignment. Overlapping effective periods for the same subject are rejected by a database exclusion constraint.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["planId"],
                properties: {
                  userId: { type: "string", maxLength: 255, description: "clientUserId; omit for account-level" },
                  planId: { type: "integer", minimum: 1 },
                  effectiveFrom: {
                    type: "string",
                    format: "date-time",
                    description: "Defaults to the current UTC month start",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Assignment created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Assignment" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
          "413": { $ref: "#/components/responses/PayloadTooLarge" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
      get: {
        tags: ["Assignments"],
        summary: "List current and historical assignments",
        responses: {
          "200": {
            description: "All assignments for this account, including superseded ones",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Assignment" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
    "/assignments/current": {
      get: {
        tags: ["Assignments"],
        summary: "List only the assignments effective right now",
        responses: {
          "200": {
            description: "Currently effective assignments",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Assignment" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
    "/users": {
      post: {
        tags: ["Users"],
        summary: "Create a user within this account",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["clientUserId"],
                properties: { clientUserId: { type: "string", minLength: 1, maxLength: 255 } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "User created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    clientUserId: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "409": { $ref: "#/components/responses/Conflict" },
          "413": { $ref: "#/components/responses/PayloadTooLarge" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
      get: {
        tags: ["Users"],
        summary: "List users in this account",
        responses: {
          "200": {
            description: "Users for this account",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/User" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openApiSpec;
