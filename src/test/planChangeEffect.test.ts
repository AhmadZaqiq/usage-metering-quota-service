import { describe, it, expect } from "vitest";
import { getTestDb } from "./setup.js";
import { usageCounters, usageRequests } from "../db/schema/index.js";
import { eq, and, isNull, sql } from "drizzle-orm";
import { updatePlan } from "../application/plans/planService.js";
import { processUsageRequest } from "../application/usage/usageService.js";
import { upsertAndLockCounter } from "../infrastructure/repositories/counterRepository.js";
import { formatDateForDb, getUtcMonthStart } from "../domain/date.js";
import { setupBasicTestContext, type TestContext } from "./utils.js";

/**
 * Plan-change effect tests: a successful change applies to the very next
 * request, for BOTH plan knobs (monthlyAllowance and maxUnitsPerRequest),
 * while consumed usage and history are preserved. The concurrency case
 * proves accounting stays consistent when usage races an allowance change.
 */

/** ISO instant inside the given 'YYYY-MM-DD' period, so seeded counters stay INV-5-consistent. */
function isoAtPeriodStart(periodStart: string): string {
  return `${periodStart}T00:00:00.000Z`;
}

async function readAccountCounter(context: TestContext): Promise<bigint> {
  const periodStart = formatDateForDb(getUtcMonthStart());
  const db = getTestDb();
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.accountId, BigInt(context.account.id)),
        eq(usageCounters.periodStart, periodStart),
        isNull(usageCounters.userId)
      )
    )
    .execute();
  return row?.counter ?? 0n;
}

async function readUserCounter(context: TestContext): Promise<bigint> {
  const periodStart = formatDateForDb(getUtcMonthStart());
  const db = getTestDb();
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.accountId, BigInt(context.account.id)),
        eq(usageCounters.userId, BigInt(context.user.id)),
        eq(usageCounters.periodStart, periodStart)
      )
    )
    .execute();
  return row?.counter ?? 0n;
}

describe("Plan change: per-request limit (maxUnitsPerRequest)", () => {
  it("lowering the account plan cap rejects the next request above the new cap (limitScope account)", async () => {
    const context = await setupBasicTestContext();
    const { account, apiKey } = context;

    // Account cap is 100: 150 is over-cap, 50 is within the old cap.
    const overBefore = await processUsageRequest(
      account.id,
      { units: 150n, idempotencyKey: "cap-pre-over" },
      apiKey.id
    );
    expect(overBefore.decision).toBe("rejected");
    expect(overBefore.rejectionReason).toBe("max_per_request_exceeded");
    expect(overBefore.limitScope).toBe("account");

    const withinOld = await processUsageRequest(
      account.id,
      { units: 50n, idempotencyKey: "cap-pre-within" },
      apiKey.id
    );
    expect(withinOld.decision).toBe("accepted");

    // Lower the cap to 20: the same 50 units must now be rejected.
    await updatePlan(context.accountPlan.id, { maxUnitsPerRequest: 20n }, account.id);

    const overAfter = await processUsageRequest(
      account.id,
      { units: 50n, idempotencyKey: "cap-post-over" },
      apiKey.id
    );
    expect(overAfter.decision).toBe("rejected");
    expect(overAfter.rejectionReason).toBe("max_per_request_exceeded");
    expect(overAfter.limitScope).toBe("account");
    // A cap rejection consumes nothing: remaining stays 1000 - 50.
    expect(overAfter.accountRemaining.toString()).toBe("950");

    // Within the new cap: still accepted.
    const withinNew = await processUsageRequest(
      account.id,
      { units: 20n, idempotencyKey: "cap-post-within" },
      apiKey.id
    );
    expect(withinNew.decision).toBe("accepted");
    expect(withinNew.accountRemaining.toString()).toBe("930");

    // Raising the cap back re-admits larger requests on the next request.
    await updatePlan(context.accountPlan.id, { maxUnitsPerRequest: 500n }, account.id);
    const overCapGone = await processUsageRequest(
      account.id,
      { units: 150n, idempotencyKey: "cap-raise" },
      apiKey.id
    );
    expect(overCapGone.decision).toBe("accepted");
    expect(overCapGone.accountRemaining.toString()).toBe("780");
  });

  it("lowering the user plan cap rejects the next request above the new cap (limitScope user)", async () => {
    const context = await setupBasicTestContext();
    const { account, user, apiKey } = context;

    // User cap is 10; the account cap (100) is looser, so the user cap binds.
    const withinOld = await processUsageRequest(
      account.id,
      { userId: user.clientUserId, units: 10n, idempotencyKey: "ucap-within" },
      apiKey.id
    );
    expect(withinOld.decision).toBe("accepted");

    // Lower the user cap to 4: 7 units is now over-cap even though 7 < 10 before.
    await updatePlan(context.userPlan.id, { maxUnitsPerRequest: 4n }, account.id);

    const overAfter = await processUsageRequest(
      account.id,
      { userId: user.clientUserId, units: 7n, idempotencyKey: "ucap-over" },
      apiKey.id
    );
    expect(overAfter.decision).toBe("rejected");
    expect(overAfter.rejectionReason).toBe("max_per_request_exceeded");
    expect(overAfter.limitScope).toBe("user");
    expect(overAfter.userRemaining!.toString()).toBe("90");
    expect(overAfter.accountRemaining.toString()).toBe("990");

    // Raise the user cap above the account cap (50 > 100? no): raise to 50,
    // account cap 100 still looser than... account cap is 100, so 30 passes
    // both after the raise.
    await updatePlan(context.userPlan.id, { maxUnitsPerRequest: 50n }, account.id);
    const afterRaise = await processUsageRequest(
      account.id,
      { userId: user.clientUserId, units: 30n, idempotencyKey: "ucap-raise" },
      apiKey.id
    );
    expect(afterRaise.decision).toBe("accepted");
    expect(afterRaise.userRemaining!.toString()).toBe("60");
  });

  it("a cap rejection never moves counters and remains inspectable in history", async () => {
    const context = await setupBasicTestContext();
    const { account, apiKey } = context;

    const accepted = await processUsageRequest(
      account.id,
      { units: 40n, idempotencyKey: "cap-hist-ok" },
      apiKey.id
    );
    expect(accepted.decision).toBe("accepted");

    await updatePlan(context.accountPlan.id, { maxUnitsPerRequest: 10n }, account.id);
    const rejected = await processUsageRequest(
      account.id,
      { units: 11n, idempotencyKey: "cap-hist-rejected" },
      apiKey.id
    );
    expect(rejected.decision).toBe("rejected");

    expect((await readAccountCounter(context)).toString()).toBe("40");

    const db = getTestDb();
    const rows = await db
      .select()
      .from(usageRequests)
      .where(eq(usageRequests.accountId, BigInt(context.account.id)))
      .execute();
    const rejectedRow = rows.find((r) => r.idempotencyKey === "cap-hist-rejected");
    expect(rejectedRow).toBeDefined();
    expect(rejectedRow!.decision).toBe("rejected");
    expect(rejectedRow!.rejectionReason).toBe("max_per_request_exceeded");
    expect(rejectedRow!.units.toString()).toBe("11");
  });
});

describe("Plan change: allowance preserved and applied under concurrency", () => {
  it("raising an allowance never resets counters; next remaining = new allowance - consumed", async () => {
    const context = await setupBasicTestContext();
    const { account, apiKey } = context;

    const pre = await processUsageRequest(
      account.id,
      { units: 100n, idempotencyKey: "allow-preserve" },
      apiKey.id
    );
    expect(pre.decision).toBe("accepted");
    const counterBefore = await readAccountCounter(context);
    expect(counterBefore.toString()).toBe("100");

    await updatePlan(context.accountPlan.id, { monthlyAllowance: 5_000n }, account.id);

    // The PATCH itself must not touch consumption.
    expect((await readAccountCounter(context)).toString()).toBe("100");

    const post = await processUsageRequest(
      account.id,
      { units: 1n, idempotencyKey: "allow-preserve-post" },
      apiKey.id
    );
    expect(post.decision).toBe("accepted");
    expect(post.accountRemaining.toString()).toBe("4899"); // 5000 - 100 - 1
  });

  it("usage racing an allowance raise keeps accounting exact (accepted sum == counters, rejections recorded)", async () => {
    const context = await setupBasicTestContext();
    const { account, user, apiKey } = context;

    // Make the user plan non-binding so only the account quota races the PATCH.
    await updatePlan(context.userPlan.id, { monthlyAllowance: 100_000n, maxUnitsPerRequest: 100n }, account.id);

    // Seed this month's counters at 990 consumed (allowance 1000 -> 10 left),
    // with INV-5-consistent timestamps.
    const periodStart = formatDateForDb(getUtcMonthStart());
    const iso = isoAtPeriodStart(periodStart);
    await upsertAndLockCounter(getTestDb(), BigInt(account.id), null, periodStart, iso);
    await upsertAndLockCounter(getTestDb(), BigInt(account.id), BigInt(user.id), periodStart, iso);
    const db = getTestDb();
    await db
      .update(usageCounters)
      .set({ counter: 990n })
      .where(eq(usageCounters.accountId, BigInt(account.id)))
      .execute();

    // Phase A (deterministic): 15 requests for 10 remaining units.
    const phaseA = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        processUsageRequest(
          account.id,
          { userId: user.clientUserId, units: 1n, idempotencyKey: `race-a-${i}` },
          apiKey.id
        )
      )
    );
    const aAccepted = phaseA.filter((r) => r.decision === "accepted").length;
    const aRejected = phaseA.filter((r) => r.decision === "rejected").length;
    expect(aAccepted).toBe(10);
    expect(aRejected).toBe(5);
    expect((await readAccountCounter(context)).toString()).toBe("1000");

    // Phase B: 30 requests racing the allowance raise. Whichever side of the
    // committed PATCH each admission lands on, the accounting must stay exact.
    const [patchResult, phaseB] = await Promise.all([
      updatePlan(context.accountPlan.id, { monthlyAllowance: 100_000n }, account.id),
      Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          processUsageRequest(
            account.id,
            { userId: user.clientUserId, units: 1n, idempotencyKey: `race-b-${i}` },
            apiKey.id
          )
        )
      ),
    ]);
    expect(patchResult.monthlyAllowance).toBe(100_000n);

    const bAccepted = phaseB.filter((r) => r.decision === "accepted").length;
    const bRejected = phaseB.filter((r) => r.decision === "rejected").length;
    const totalAccepted = aAccepted + bAccepted;
    // The old headroom guaranteed 10 accepts in phase A; phase B may add 0..30.
    expect(totalAccepted).toBeGreaterThanOrEqual(10);
    expect(totalAccepted).toBeLessThanOrEqual(40);
    expect(aAccepted + aRejected + bAccepted + bRejected).toBe(45);

    // INV-1/INV-2: counters equal the sum of accepted units (seeded 990 + accepted).
    const expected = 990n + BigInt(totalAccepted);
    expect((await readAccountCounter(context)).toString()).toBe(expected.toString());
    expect((await readUserCounter(context)).toString()).toBe(expected.toString());

    // INV-4: no response ever exposed a negative remaining.
    for (const r of [...phaseA, ...phaseB]) {
      expect(r.accountRemaining >= 0n).toBe(true);
      if (r.userRemaining !== undefined) {
        expect(r.userRemaining >= 0n).toBe(true);
      }
    }

    // Rejected attempts stay inspectable and carry zero contribution.
    const rejectedCount = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(usageRequests)
      .where(
        and(
          eq(usageRequests.accountId, BigInt(account.id)),
          eq(usageRequests.decision, "rejected")
        )
      )
      .execute();
    expect(rejectedCount[0]!.n).toBe(aRejected + bRejected);

    // After the raise, the next request sees the new budget immediately.
    const after = await processUsageRequest(
      account.id,
      { userId: user.clientUserId, units: 1n, idempotencyKey: "race-post" },
      apiKey.id
    );
    expect(after.decision).toBe("accepted");
    expect(after.accountRemaining.toString()).toBe((100_000n - 990n - BigInt(totalAccepted) - 1n).toString());
  }, 60_000);
});
