import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// The readiness endpoint must never echo raw driver errors (they can contain
// hostnames, usernames, or auth details) back to clients.
vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>();
  return {
    ...actual,
    checkDatabaseHealth: async () => ({
      healthy: false,
      latencyMs: 3,
      error: "password authentication failed for user app at db.internal:5432",
    }),
  };
});

const { createApp } = await import("../app.js");

describe("GET /health/ready when the database is down", () => {
  it("returns 503 with a generic message and no driver details", async () => {
    const app = createApp();
    const res = await request(app).get("/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.database.healthy).toBe(false);
    expect(res.body.checks.database.error).toBe("database unavailable");

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("db.internal");
    expect(raw).not.toContain("app@");
  });
});
