import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { getTestDb } from "./setup.js";
import { usageCounters, usageRequests } from "../db/schema/index.js";
import { setupBasicTestContext, makeUsageRequest } from "./utils.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("UTC month-boundary period semantics", () => {
  it("assigns each request to its admission-time UTC month and starts a fresh counter period after the boundary", async () => {
    const ctx = await setupBasicTestContext();

    // Freeze only the JS clock (Date): transactions, sockets, and the pg pool
    // keep using real timers, so database calls cannot stall on fake timers.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-31T23:59:59.999Z") });

    const before = await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      units: 5n,
      idempotencyKey: "boundary-before-1",
    });
    expect(before.decision).toBe("accepted");
    expect(before.periodStart).toBe("2026-10-01");

    // Cross the UTC month boundary (~2s later).
    vi.setSystemTime(new Date("2026-11-01T00:00:01.000Z"));

    const after = await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      units: 7n,
      idempotencyKey: "boundary-after-1",
    });
    expect(after.decision).toBe("accepted");
    expect(after.periodStart).toBe("2026-11-01");
    // November remaining reflects the fresh period, not October's usage.
    expect(after.accountRemaining).toBe(ctx.accountPlan.monthlyAllowance - 7n);

    // Persisted decision rows carry the same periods the client saw.
    const db = getTestDb();
    const requests = await db
      .select({
        idempotencyKey: usageRequests.idempotencyKey,
        periodStart: usageRequests.periodStart,
        units: usageRequests.units,
        decision: usageRequests.decision,
      })
      .from(usageRequests)
      .where(eq(usageRequests.accountId, BigInt(ctx.account.id)))
      .execute();

    expect(requests).toHaveLength(2);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: "boundary-before-1",
          periodStart: "2026-10-01",
          units: 5n,
          decision: "accepted",
        }),
        expect.objectContaining({
          idempotencyKey: "boundary-after-1",
          periodStart: "2026-11-01",
          units: 7n,
          decision: "accepted",
        }),
      ])
    );

    // Separate counter periods: October ends at 5, November starts fresh at 7.
    const counters = await db
      .select({ periodStart: usageCounters.periodStart, counter: usageCounters.counter })
      .from(usageCounters)
      .where(and(eq(usageCounters.accountId, BigInt(ctx.account.id)), isNull(usageCounters.userId)))
      .execute();

    expect(counters).toHaveLength(2);
    const oct = counters.find((c) => c.periodStart === "2026-10-01");
    const nov = counters.find((c) => c.periodStart === "2026-11-01");
    expect(oct?.counter).toBe(5n);
    expect(nov?.counter).toBe(7n);
  });

  it("replays a request committed in the previous month with its original period and does not touch the new period", async () => {
    const ctx = await setupBasicTestContext();

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-31T23:59:59.999Z") });

    const original = await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      units: 4n,
      idempotencyKey: "replay-across-boundary",
    });
    expect(original.decision).toBe("accepted");
    expect(original.periodStart).toBe("2026-10-01");

    vi.setSystemTime(new Date("2026-11-01T00:00:01.000Z"));

    const replay = await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      units: 4n,
      idempotencyKey: "replay-across-boundary",
    });
    // Replay returns the original committed decision. Compared per field:
    // the live path omits optional fields (undefined) while the replay path
    // reads them from nullable DB columns (null), which is equivalent for
    // the documented contract.
    expect(replay.decision).toBe(original.decision);
    expect(replay.periodStart).toBe(original.periodStart);
    expect(replay.accountRemaining).toBe(original.accountRemaining);
    expect(replay.userRemaining).toBe(original.userRemaining);

    // The replay started no November period.
    const db = getTestDb();
    const novCounters = await db
      .select()
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.accountId, BigInt(ctx.account.id)),
          eq(usageCounters.periodStart, "2026-11-01")
        )
      )
      .execute();
    expect(novCounters).toHaveLength(0);
  });
});
