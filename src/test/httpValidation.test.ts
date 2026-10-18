import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { setupBasicTestContext, TestContext } from "./utils.js";
import { getUsageHistory } from "../application/usage/usageHistoryService.js";

// BR-06: empty userId strings must be rejected at the schema boundary
// (400 VALIDATION_ERROR) instead of reaching services as a user-scoped
// request with a meaningless subject.
describe("HTTP input validation", () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    app = createApp();
    context = await setupBasicTestContext();
  });

  it("POST /usage rejects an empty userId with 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post("/usage")
      .set("Authorization", `Bearer ${context.apiKey.key}`)
      .send({ userId: "", units: "1", idempotencyKey: "empty-user-id" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");

    // Rejected at validation: nothing was persisted.
    const page = await getUsageHistory(BigInt(context.account.id), 1, 10);
    expect(page.items).toHaveLength(0);
  });

  it("POST /assignments rejects an empty userId with 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post("/assignments")
      .set("Authorization", `Bearer ${context.apiKey.key}`)
      .send({ planId: context.userPlan.id, userId: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /usage still accepts a valid userId (positive control)", async () => {
    const res = await request(app)
      .post("/usage")
      .set("Authorization", `Bearer ${context.apiKey.key}`)
      .send({ userId: context.user.clientUserId, units: "1", idempotencyKey: "valid-user-id" });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("accepted");
  });
});
