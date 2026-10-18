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
    expect(usage.body.items.map((i: { idempotencyKey: string }) => i.idempotencyKey)).toContain(
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
    const keys = resB.body.items.map((i: { idempotencyKey: string }) => i.idempotencyKey);
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
