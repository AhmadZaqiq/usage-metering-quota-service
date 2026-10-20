import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { getTestDb } from "./setup.js";
import { setupBasicTestContext, makeUsageRequest } from "./utils.js";
import { usageCounters, users as usersTable } from "../db/schema/index.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getUtcMonthStart, formatDateForDb } from "../domain/date.js";
import { parsePeriodStart } from "../application/usage/usageSummaryService.js";
import { ValidationError } from "../errors/AppError.js";

const PREVIOUS_MONTH = (() => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
})();

describe("parsePeriodStart", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("defaults to the current UTC month", () => {
    expect(parsePeriodStart(undefined, now)).toBe("2026-10-01");
  });

  it("accepts YYYY-MM and YYYY-MM-01", () => {
    expect(parsePeriodStart("2026-09", now)).toBe("2026-09-01");
    expect(parsePeriodStart("2026-09-01", now)).toBe("2026-09-01");
  });

  it("rejects malformed and future periods", () => {
    expect(() => parsePeriodStart("garbage", now)).toThrow(ValidationError);
    expect(() => parsePeriodStart("2026-13", now)).toThrow(ValidationError);
    expect(() => parsePeriodStart("2026-00", now)).toThrow(ValidationError);
    expect(() => parsePeriodStart("2026-11", now)).toThrow(ValidationError);
    expect(() => parsePeriodStart("2027-01-01", now)).toThrow(ValidationError);
  });
});

describe("HTTP usage summary (GET /usage/summary)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("returns consumed and remaining for the current month, per account and user", async () => {
    const ctx = await setupBasicTestContext();
    const auth = { Authorization: `Bearer ${ctx.apiKey.key}` };

    await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      userId: ctx.user.clientUserId,
      units: 5n,
      idempotencyKey: `sum-a-${ctx.account.id}`,
    });
    await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      userId: ctx.user.clientUserId,
      units: 3n,
      idempotencyKey: `sum-b-${ctx.account.id}`,
    });
    // Over the user per-request cap: rejected, must not consume.
    await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      userId: ctx.user.clientUserId,
      units: 50n,
      idempotencyKey: `sum-rej-${ctx.account.id}`,
    });

    const res = await request(app).get("/usage/summary").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.periodStart).toBe(formatDateForDb(getUtcMonthStart()));
    expect(res.body.account).toMatchObject({
      accountId: String(ctx.account.id),
      planName: "Account Plan",
      monthlyAllowance: "1000",
      maxUnitsPerRequest: "100",
      consumed: "8",
      remaining: "992",
    });
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({
      userId: String(ctx.user.id),
      clientUserId: ctx.user.clientUserId,
      isActive: true,
      planName: "User Plan",
      monthlyAllowance: "100",
      maxUnitsPerRequest: "10",
      consumed: "8",
      remaining: "92",
    });
  });

  it("reads historical months from the counters and clamps remaining under the current plan", async () => {
    const ctx = await setupBasicTestContext();
    const auth = { Authorization: `Bearer ${ctx.apiKey.key}` };
    const db = getTestDb();
    const prev = formatDateForDb(PREVIOUS_MONTH);

    // Authoritative prior-month counters (as a past month's accepted usage left them).
    await db
      .insert(usageCounters)
      .values([
        {
          accountId: BigInt(ctx.account.id),
          userId: null,
          periodStart: prev,
          counter: 40n,
        },
        {
          accountId: BigInt(ctx.account.id),
          userId: BigInt(ctx.user.id),
          periodStart: prev,
          counter: 25n,
        },
      ])
      .execute();

    const res = await request(app).get(`/usage/summary?periodStart=${prev.slice(0, 7)}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.periodStart).toBe(prev);
    expect(res.body.account.consumed).toBe("40");
    expect(res.body.account.remaining).toBe("960"); // 1000 - 40
    expect(res.body.users[0].consumed).toBe("25");
    expect(res.body.users[0].remaining).toBe("75"); // 100 - 25
  });

  it("returns zero consumption for an empty historical month", async () => {
    const ctx = await setupBasicTestContext();
    const auth = { Authorization: `Bearer ${ctx.apiKey.key}` };
    const prev = formatDateForDb(PREVIOUS_MONTH);

    // Ensure no counter rows exist for this account in the previous month.
    const db = getTestDb();
    await db
      .delete(usageCounters)
      .where(
        and(
          eq(usageCounters.accountId, BigInt(ctx.account.id)),
          eq(usageCounters.periodStart, prev),
        ),
      )
      .execute();

    const res = await request(app).get(`/usage/summary?periodStart=${prev.slice(0, 7)}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.account.consumed).toBe("0");
    expect(res.body.account.remaining).toBe("1000");
    expect(res.body.users[0].consumed).toBe("0");
    expect(res.body.users[0].remaining).toBe("100");
  });

  it("reflects a plan allowance change on the next summary read without touching consumed", async () => {
    const ctx = await setupBasicTestContext();
    const auth = { Authorization: `Bearer ${ctx.apiKey.key}` };

    await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      userId: ctx.user.clientUserId,
      units: 8n,
      idempotencyKey: `sum-plan-${ctx.account.id}`,
    });

    // Lower the user plan allowance below... above usage here; then check.
    const patch = await request(app)
      .patch(`/plans/${ctx.userPlan.id}`)
      .set(auth)
      .send({ monthlyAllowance: "50" });
    expect(patch.status).toBe(200);

    const res = await request(app).get("/usage/summary").set(auth);
    expect(res.body.users[0].consumed).toBe("8");
    expect(res.body.users[0].monthlyAllowance).toBe("50");
    expect(res.body.users[0].remaining).toBe("42");
  });

  it("clamps remaining at zero when the allowance drops below consumed", async () => {
    const ctx = await setupBasicTestContext();
    const auth = { Authorization: `Bearer ${ctx.apiKey.key}` };

    await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      userId: ctx.user.clientUserId,
      units: 9n,
      idempotencyKey: `sum-clamp-${ctx.account.id}`,
    });

    const patch = await request(app)
      .patch(`/plans/${ctx.userPlan.id}`)
      .set(auth)
      .send({ monthlyAllowance: "5" });
    expect(patch.status).toBe(200);

    const res = await request(app).get("/usage/summary").set(auth);
    expect(res.body.users[0].consumed).toBe("9");
    expect(res.body.users[0].remaining).toBe("0");
  });

  it("filters by userId and 404s unknown users; keeps tenants isolated", async () => {
    const ctx = await setupBasicTestContext();
    const auth = { Authorization: `Bearer ${ctx.apiKey.key}` };

    const db = getTestDb();
    await db
      .insert(usersTable)
      .values({ accountId: BigInt(ctx.account.id), clientUserId: "second-user" })
      .execute();

    const filtered = await request(app)
      .get(`/usage/summary?userId=${ctx.user.clientUserId}`)
      .set(auth);
    expect(filtered.status).toBe(200);
    expect(filtered.body.users).toHaveLength(1);
    expect(filtered.body.users[0].clientUserId).toBe(ctx.user.clientUserId);

    const unknown = await request(app).get("/usage/summary?userId=nope").set(auth);
    expect(unknown.status).toBe(404);

    // A different account's key sees only its own (empty) world.
    const other = await setupBasicTestContext();
    const otherRes = await request(app)
      .get("/usage/summary")
      .set({ Authorization: `Bearer ${other.apiKey.key}` });
    expect(otherRes.status).toBe(200);
    expect(otherRes.body.account.accountId).toBe(String(other.account.id));
    expect(otherRes.body.account.consumed).toBe("0");
    expect(
      otherRes.body.users.every(
        (u: { clientUserId: string }) => u.clientUserId === other.user.clientUserId,
      ),
    ).toBe(true);
  });

  it("shows users without a plan as nulls with zero consumption", async () => {
    const ctx = await setupBasicTestContext();
    const auth = { Authorization: `Bearer ${ctx.apiKey.key}` };

    const db = getTestDb();
    await db
      .insert(usersTable)
      .values({ accountId: BigInt(ctx.account.id), clientUserId: "planless" })
      .execute();

    const res = await request(app).get("/usage/summary").set(auth);
    expect(res.status).toBe(200);
    const planless = res.body.users.find(
      (u: { clientUserId: string }) => u.clientUserId === "planless",
    );
    expect(planless).toBeDefined();
    expect(planless.isActive).toBe(true);
    expect(planless.planId).toBeNull();
    expect(planless.planName).toBeNull();
    expect(planless.monthlyAllowance).toBeNull();
    expect(planless.remaining).toBeNull();
    expect(planless.consumed).toBe("0");
  });

  it("rejects invalid and future periodStart values with 400", async () => {
    const ctx = await setupBasicTestContext();
    const auth = { Authorization: `Bearer ${ctx.apiKey.key}` };

    const garbage = await request(app).get("/usage/summary?periodStart=garbage").set(auth);
    expect(garbage.status).toBe(400);

    const badMonth = await request(app).get("/usage/summary?periodStart=2026-13").set(auth);
    expect(badMonth.status).toBe(400);

    const nextMonth = new Date();
    const future = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 2).padStart(2, "0")}`;
    const futureRes = await request(app).get(`/usage/summary?periodStart=${future}`).set(auth);
    expect(futureRes.status).toBe(400);
  });
});
