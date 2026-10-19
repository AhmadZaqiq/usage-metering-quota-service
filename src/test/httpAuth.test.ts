import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { setupBasicTestContext, TestContext } from "./utils.js";
import { getTestDb } from "./setup.js";
import { accounts } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { revokeApiKey } from "../application/auth/apiKeyService.js";

// HTTP-level authentication and tenant-isolation tests (TST-01): these go
// through the real Express pipeline (IP limiter -> auth -> identity limiter ->
// route) against the real PostgreSQL test database.

describe("HTTP authentication", () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    app = createApp();
    context = await setupBasicTestContext();
  });

  const authHeader = (key: string) => ({ Authorization: `Bearer ${key}` });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await request(app).post("/usage").send({ units: "1", idempotencyKey: "k1" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 for a non-Bearer scheme", async () => {
    const res = await request(app)
      .post("/usage")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({ units: "1", idempotencyKey: "k1" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("returns 401 for an unknown key prefix", async () => {
    const res = await request(app)
      .post("/usage")
      .set("Authorization", `Bearer deadbeefdeadbeef.${"0".repeat(64)}`)
      .send({ units: "1", idempotencyKey: "k1" });

    expect(res.status).toBe(401);
  });

  it("returns 401 when the secret does not match the stored hash", async () => {
    const res = await request(app)
      .post("/usage")
      .set("Authorization", `Bearer ${context.apiKey.prefix}.${"1".repeat(64)}`)
      .send({ units: "1", idempotencyKey: "k1" });

    expect(res.status).toBe(401);
  });

  it("returns 401 for a malformed key (no prefix.secret structure)", async () => {
    const res = await request(app)
      .post("/usage")
      .set("Authorization", "Bearer not-a-valid-key")
      .send({ units: "1", idempotencyKey: "k1" });

    expect(res.status).toBe(401);
  });

  it("returns 401 after the key is revoked", async () => {
    await revokeApiKey(context.account.id, context.apiKey.id);

    const res = await request(app)
      .post("/usage")
      .set(authHeader(context.apiKey.key))
      .send({ units: "1", idempotencyKey: "k1" });

    expect(res.status).toBe(401);
  });

  it("returns 401 when the account is deactivated", async () => {
    await getTestDb()
      .update(accounts)
      .set({ isActive: false })
      .where(eq(accounts.id, BigInt(context.account.id)))
      .execute();

    const res = await request(app)
      .get("/plans")
      .set(authHeader(context.apiKey.key));

    expect(res.status).toBe(401);
  });

  it("returns 401 when the account is soft-deleted", async () => {
    await getTestDb()
      .update(accounts)
      .set({ deletedAt: new Date() })
      .where(eq(accounts.id, BigInt(context.account.id)))
      .execute();

    const res = await request(app)
      .get("/plans")
      .set(authHeader(context.apiKey.key));

    expect(res.status).toBe(401);
  });

  it("authenticates a valid key and processes a usage request end to end", async () => {
    const res = await request(app)
      .post("/usage")
      .set(authHeader(context.apiKey.key))
      .send({ userId: context.user.clientUserId, units: "1", idempotencyKey: "http-auth-k1" });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("accepted");
    expect(res.body.accountRemaining).toBe("999");
    expect(res.body.userRemaining).toBe("99");
    // bigint counters are serialized as strings
    expect(typeof res.body.accountRemaining).toBe("string");
  });

  it("exposes rate-limit, correlation, and security headers on authenticated requests", async () => {
    const res = await request(app)
      .get("/plans")
      .set(authHeader(context.apiKey.key))
      .set("X-Request-Id", "http-auth-req-1");

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe("http-auth-req-1");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(Number(res.headers["x-ratelimit-reset"])).toBeGreaterThan(0);
  });

  it("generates a correlation id when the client does not send one", async () => {
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not accept a client-supplied account id as identity", async () => {
    // Body/query identifiers must never override the authenticated context.
    const res = await request(app)
      .post("/usage")
      .set(authHeader(context.apiKey.key))
      .query({ accountId: context.account.id + 1 })
      .send({
        userId: context.user.clientUserId,
        units: "1",
        idempotencyKey: "http-auth-k2",
        accountId: context.account.id + 1,
      });

    expect(res.status).toBe(200);
    // Consumed from the authenticated account, not the injected one.
    const usage = await request(app)
      .get("/usage")
      .set(authHeader(context.apiKey.key));
    expect(usage.status).toBe(200);
    expect(usage.body.items.map((i: { requestId: string }) => i.requestId)).toContain(
      "http-auth-k2",
    );
  });
});

describe("HTTP tenant isolation", () => {
  let app: ReturnType<typeof createApp>;
  let ctxA: TestContext;
  let ctxB: TestContext;

  beforeEach(async () => {
    app = createApp();
    ctxA = await setupBasicTestContext();
    ctxB = await setupBasicTestContext();
  });

  it("hides another account's plan behind 404", async () => {
    const res = await request(app)
      .get(`/plans/${ctxA.accountPlan.id}`)
      .set("Authorization", `Bearer ${ctxB.apiKey.key}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("lists only the caller's own plans", async () => {
    const res = await request(app)
      .get("/plans")
      .set("Authorization", `Bearer ${ctxB.apiKey.key}`);

    expect(res.status).toBe(200);
    const ids = res.body.map((p: { id: number }) => p.id);
    expect(ids).not.toContain(ctxA.accountPlan.id);
    expect(ids).toContain(ctxB.accountPlan.id);
  });

  it("keeps usage history isolated per authenticated account", async () => {
    await request(app)
      .post("/usage")
      .set("Authorization", `Bearer ${ctxA.apiKey.key}`)
      .send({ userId: ctxA.user.clientUserId, units: "1", idempotencyKey: "iso-a-1" });

    const resB = await request(app)
      .get("/usage")
      .set("Authorization", `Bearer ${ctxB.apiKey.key}`);

    expect(resB.status).toBe(200);
    const keys = resB.body.items.map((i: { requestId: string }) => i.requestId);
    expect(keys).not.toContain("iso-a-1");
  });

  it("rejects assigning another account's plan with 403", async () => {
    const res = await request(app)
      .post("/assignments")
      .set("Authorization", `Bearer ${ctxB.apiKey.key}`)
      .send({ planId: ctxA.accountPlan.id, effectiveFrom: "2026-10-01T00:00:00Z" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTHORIZATION_FAILED");
  });
});

describe("API key lifecycle over HTTP", () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    app = createApp();
    context = await setupBasicTestContext();
  });

  const authHeader = (key: string) => ({ Authorization: `Bearer ${key}` });

  it("creates a key, discloses the secret exactly once, and authenticates with it", async () => {
    const created = await request(app)
      .post("/api-keys")
      .set(authHeader(context.apiKey.key))
      .send({ name: "second-key" });

    expect(created.status).toBe(201);
    expect(created.body.id).toEqual(expect.any(Number));
    expect(created.body.name).toBe("second-key");
    expect(created.body.prefix).toMatch(/^[0-9a-f]{16}$/);
    expect(created.body.key).toMatch(
      new RegExp(`^${created.body.prefix}\\.[0-9a-f]{64}$`),
    );

    // One-time disclosure: neither the full key nor its secret part
    // appears in any subsequent listing.
    const list = await request(app)
      .get("/api-keys")
      .set(authHeader(context.apiKey.key));
    expect(list.status).toBe(200);
    const serialized = JSON.stringify(list.body);
    expect(serialized).not.toContain(created.body.key);
    expect(serialized).not.toContain(
      (created.body.key as string).split(".")[1],
    );

    const listed = (list.body as Array<Record<string, unknown>>).find(
      (k) => k.id === created.body.id,
    );
    expect(listed).toBeDefined();
    expect(listed!.prefix).toBe(created.body.prefix);

    // The newly issued key authenticates.
    const usage = await request(app)
      .post("/usage")
      .set(authHeader(created.body.key as string))
      .send({ units: "1", idempotencyKey: "keylifecycle-1" });
    expect(usage.status).toBe(200);
    expect(usage.body.decision).toBe("accepted");
  });

  it("exposes isRevoked and lastUsedAt on the list and sets lastUsedAt after use", async () => {
    const used = await request(app)
      .post("/usage")
      .set(authHeader(context.apiKey.key))
      .send({ units: "1", idempotencyKey: "keylifecycle-2" });
    expect(used.status).toBe(200);

    const list = await request(app)
      .get("/api-keys")
      .set(authHeader(context.apiKey.key));
    expect(list.status).toBe(200);

    const keys = list.body as Array<Record<string, unknown>>;
    const active = keys.find((k) => k.prefix === context.apiKey.prefix);
    expect(active).toBeDefined();
    expect(active!.isRevoked).toBe(false);
    expect(active!.lastUsedAt).not.toBeNull();
    // Field-name contract: no legacy `revoked` alias (matches the OpenAPI
    // `ApiKeyInfo` component after the Stage 2 drift fix).
    expect(keys.some((k) => "revoked" in k)).toBe(false);
    expect(keys.some((k) => "key" in k)).toBe(false);
  });

  it("revokes a key over HTTP: 204, the revoked key then gets 401", async () => {
    const created = await request(app)
      .post("/api-keys")
      .set(authHeader(context.apiKey.key))
      .send({ name: "revoke-me" });
    expect(created.status).toBe(201);

    const del = await request(app)
      .delete(`/api-keys/${created.body.id}`)
      .set(authHeader(context.apiKey.key));
    expect(del.status).toBe(204);

    // The revoked key can no longer authenticate...
    const usage = await request(app)
      .post("/usage")
      .set(authHeader(created.body.key as string))
      .send({ units: "1", idempotencyKey: "keylifecycle-3" });
    expect(usage.status).toBe(401);

    // ...revocation is per key: the original key still works...
    const still = await request(app)
      .get("/api-keys")
      .set(authHeader(context.apiKey.key));
    expect(still.status).toBe(200);

    // ...and the list reports the entry as revoked.
    const revoked = (still.body as Array<Record<string, unknown>>).find(
      (k) => k.id === created.body.id,
    );
    expect(revoked).toBeDefined();
    expect(revoked!.isRevoked).toBe(true);

    // Idempotent contract: a second DELETE is still 204.
    const again = await request(app)
      .delete(`/api-keys/${created.body.id}`)
      .set(authHeader(context.apiKey.key));
    expect(again.status).toBe(204);
  });
});
