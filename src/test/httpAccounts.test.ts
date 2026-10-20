import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app.js";
import { bootstrap } from "../scripts/bootstrap.js";
import { getTestDb } from "./setup.js";
import { setupBasicTestContext } from "./utils.js";
import { accounts, apiKeys } from "../db/schema/index.js";
import { operatorAuthOutcome } from "../presentation/middleware/operatorAuthMiddleware.js";

const OPERATOR = { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` };

describe("Operator auth outcome (pure decision)", () => {
  it("is disabled when no token is configured", () => {
    expect(operatorAuthOutcome(undefined, "Bearer anything")).toBe("disabled");
  });

  it("rejects missing or non-Bearer headers", () => {
    expect(operatorAuthOutcome("configured-token-value", undefined)).toBe("unauthorized");
    expect(operatorAuthOutcome("configured-token-value", "Basic abc")).toBe("unauthorized");
    expect(operatorAuthOutcome("configured-token-value", "Bearer wrong-token-value")).toBe("unauthorized");
  });

  it("accepts the exact configured token", () => {
    expect(operatorAuthOutcome("configured-token-value", "Bearer configured-token-value")).toBe("ok");
  });
});

describe("HTTP account provisioning (POST /accounts)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    // Seeds the system-plan catalog (Starter etc.) exactly like a compose
    // deployment; BOOTSTRAP_* are unset in tests so no account is created.
    await bootstrap();
    app = createApp();
  });

  it("rejects requests without the operator credential", async () => {
    const res = await request(app).post("/accounts").send({ name: "No Token Co" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong operator token", async () => {
    const res = await request(app)
      .post("/accounts")
      .set("Authorization", "Bearer not-the-operator-token")
      .send({ name: "Wrong Token Co" });
    expect(res.status).toBe(401);
  });

  it("rejects an ordinary tenant API key (not the operator credential)", async () => {
    const ctx = await setupBasicTestContext();
    const res = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${ctx.apiKey.key}`)
      .send({ name: "Tenant Key Co" });
    expect(res.status).toBe(401);
  });

  it("validates the request body", async () => {
    const empty = await request(app).post("/accounts").set(OPERATOR).send({ name: "" });
    expect(empty.status).toBe(400);

    const missing = await request(app).post("/accounts").set(OPERATOR).send({});
    expect(missing.status).toBe(400);

    const longName = await request(app)
      .post("/accounts")
      .set(OPERATOR)
      .send({ name: "x".repeat(256) });
    expect(longName.status).toBe(400);

    const longKeyName = await request(app)
      .post("/accounts")
      .set(OPERATOR)
      .send({ name: "Valid Co", apiKeyName: "k".repeat(101) });
    expect(longKeyName.status).toBe(400);
  });

  it("creates an account with Starter assignment and a first API key atomically", async () => {
    // Re-seed inside the test: the shared test DB is truncated by other
    // files' beforeAll hooks when vitest runs files in parallel.
    await bootstrap();
    const res = await request(app)
      .post("/accounts")
      .set(OPERATOR)
      .send({ name: `Provision Co ${Date.now()}`, apiKeyName: "Primary Key" });

    expect(res.status).toBe(201);
    expect(res.body.account.name).toMatch(/^Provision Co /);
    expect(res.body.apiKey.name).toBe("Primary Key");
    expect(res.body.apiKey.key).toMatch(/^[a-f0-9]{16}\.[a-f0-9]{64}$/);
    expect(res.body.apiKey.prefix).toBe(res.body.apiKey.key.split(".")[0]);

    // The plaintext key is returned once and authenticates immediately.
    const me = await request(app)
      .get("/users")
      .set("Authorization", `Bearer ${res.body.apiKey.key}`);
    expect(me.status).toBe(200);
    expect(me.body).toEqual([]);

    // Default Starter system plan assignment is current for the account.
    const current = await request(app)
      .get("/assignments/current")
      .set("Authorization", `Bearer ${res.body.apiKey.key}`);
    expect(current.status).toBe(200);
    expect(current.body.account.planName).toBe("Starter");
    expect(current.body.account.planType).toBe("account");

    // Only the hash is stored, never the plaintext secret.
    const db = getTestDb();
    const rows = await db
      .select({ keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.id, BigInt(res.body.apiKey.id)))
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].keyHash).not.toBe(res.body.apiKey.key);
    expect(rows[0].keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.apiKey.key).not.toContain(rows[0].keyHash);
  });

  it("keeps the new account isolated from existing accounts", async () => {
    await bootstrap();
    const existing = await setupBasicTestContext();
    const created = await request(app)
      .post("/accounts")
      .set(OPERATOR)
      .send({ name: `Isolation Co ${Date.now()}` });
    expect(created.status).toBe(201);
    const newKey = created.body.apiKey.key as string;

    // New key sees no users and only the shared system-plan catalog.
    const users = await request(app).get("/users").set("Authorization", `Bearer ${newKey}`);
    expect(users.status).toBe(200);
    expect(users.body).toEqual([]);

    const usage = await request(app).get("/usage?limit=1").set("Authorization", `Bearer ${newKey}`);
    expect(usage.status).toBe(200);
    expect(usage.body.total).toBe(0);

    // Existing account still sees its own data only.
    const theirUsers = await request(app)
      .get("/users")
      .set("Authorization", `Bearer ${existing.apiKey.key}`);
    expect(theirUsers.status).toBe(200);
    expect(theirUsers.body).toHaveLength(1);
    expect(theirUsers.body[0].clientUserId).toBe(existing.user.clientUserId);
  });

  it("returns 409 on duplicate account names without partial rows", async () => {
    await bootstrap();
    const name = `Duplicate Co ${Date.now()}`;
    const first = await request(app).post("/accounts").set(OPERATOR).send({ name });
    expect(first.status).toBe(201);

    const db = getTestDb();
    const before = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.name, name))
      .execute();
    expect(before).toHaveLength(1);

    const second = await request(app).post("/accounts").set(OPERATOR).send({ name });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");

    // The failed attempt left no additional account and no extra key.
    const after = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.name, name))
      .execute();
    expect(after).toHaveLength(1);

    const keys = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.accountId, before[0].id))
      .execute();
    expect(keys).toHaveLength(1);
  });
});
