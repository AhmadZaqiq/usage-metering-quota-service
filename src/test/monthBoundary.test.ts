import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { getTestDb, getTestPool } from "./setup.js";
import { usageCounters, usageRequests } from "../db/schema/index.js";
import { setupBasicTestContext, makeUsageRequest } from "./utils.js";
import { formatDateForDb, getUtcMonthStart } from "../domain/date.js";

afterEach(() => {
  vi.useRealTimers();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until a queued admission request is either blocked on a row lock
 * (account row FOR UPDATE, or the account-counter upsert) or has already
 * settled. Proves the request genuinely reached its blocking point instead of
 * trusting a fixed sleep; returning early on `settled` keeps this helper valid
 * for an implementation that does not block at all.
 */
async function waitForQueuedAdmission(
  pending: Promise<unknown>,
  min: number,
  timeoutMs = 15000
): Promise<void> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  pending.then(mark, mark);

  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    if (settled) return;
    const res = await getTestPool().query(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()
          AND (query ILIKE '%FOR UPDATE%' OR query ILIKE '%INSERT INTO usage_counters%')`
    );
    seen = res.rows[0].n as number;
    if (seen >= min) return;
    await sleep(25);
  }
  throw new Error(
    `timed out waiting for ${min} queued admission request(s) to block (last saw ${seen}, settled=${settled})`
  );
}

/**
 * Holds the admission locks for the OLD side of a simulated boundary: the
 * period-independent account row lock (taken by a post-lock admission
 * implementation) and the old-period account-counter row (taken by a
 * pre-lock/period-first implementation), so a queued request blocks under
 * either ordering until `release` is called. The callback must release
 * before awaiting the queued request.
 */
async function withHeldAdmissionLock<T>(
  accountId: number,
  oldPeriodStart: string,
  fn: (release: () => Promise<void>) => Promise<T>
): Promise<T> {
  const holder = await getTestPool().connect();
  let released = false;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [
      String(accountId),
    ]);
    await holder.query(
      `INSERT INTO usage_counters (account_id, user_id, period_start, counter)
       VALUES ($1, NULL, $2, 0)
       ON CONFLICT (account_id, period_start) WHERE user_id IS NULL
       DO UPDATE SET counter = usage_counters.counter`,
      [String(accountId), oldPeriodStart]
    );
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await holder.query("ROLLBACK");
    };
    return await fn(release);
  } finally {
    if (!released) {
      await holder.query("ROLLBACK");
    }
    holder.release();
  }
}

describe("UTC month-boundary period semantics", () => {
  it("assigns each request to its admission-time UTC month and starts a fresh counter period after the boundary", async () => {
    const ctx = await setupBasicTestContext();

    const before = await makeUsageRequest(
      ctx.account.id,
      ctx.apiKey.id,
      { units: 5n, idempotencyKey: "boundary-before-1" },
      { admissionTimestamp: () => "2026-10-31T23:59:59.000Z" }
    );
    expect(before.decision).toBe("accepted");
    expect(before.periodStart).toBe("2026-10-01");
    expect(before.accountRemaining).toBe(ctx.accountPlan.monthlyAllowance - 5n);

    const after = await makeUsageRequest(
      ctx.account.id,
      ctx.apiKey.id,
      { units: 7n, idempotencyKey: "boundary-after-1" },
      { admissionTimestamp: () => "2026-11-01T00:00:01.000Z" }
    );
    expect(after.decision).toBe("accepted");
    expect(after.periodStart).toBe("2026-11-01");
    // November remaining reflects the fresh period, not October's usage.
    expect(after.accountRemaining).toBe(ctx.accountPlan.monthlyAllowance - 7n);

    // Persisted decision rows carry the same periods the client saw, and the
    // persisted created_at is the admission timestamp that chose the period
    // (INV-5: period_start == UTC month of created_at, exact per request).
    const db = getTestDb();
    const requests = await db
      .select({
        idempotencyKey: usageRequests.idempotencyKey,
        periodStart: usageRequests.periodStart,
        units: usageRequests.units,
        decision: usageRequests.decision,
        createdAt: usageRequests.createdAt,
      })
      .from(usageRequests)
      .where(eq(usageRequests.accountId, BigInt(ctx.account.id)))
      .execute();

    expect(requests).toHaveLength(2);
    const octRow = requests.find((r) => r.idempotencyKey === "boundary-before-1");
    const novRow = requests.find((r) => r.idempotencyKey === "boundary-after-1");
    expect(octRow).toMatchObject({ periodStart: "2026-10-01", units: 5n, decision: "accepted" });
    expect(novRow).toMatchObject({ periodStart: "2026-11-01", units: 7n, decision: "accepted" });
    expect(formatDateForDb(getUtcMonthStart(octRow!.createdAt))).toBe("2026-10-01");
    expect(formatDateForDb(getUtcMonthStart(novRow!.createdAt))).toBe("2026-11-01");

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

  it("locks admission across the boundary so a request queued before midnight lands in the new month", async () => {
    const ctx = await setupBasicTestContext();

    // Simulated boundary: the request starts on the October side, blocks
    // behind the held admission lock, and is admitted only after the clock
    // has moved into November. The admission timestamp must be observed
    // AFTER the lock is granted, so the period follows the post-lock time.
    let admission = "2026-10-31T23:59:59.500Z";

    await withHeldAdmissionLock(ctx.account.id, "2026-10-01", async (release) => {
      const pending = makeUsageRequest(
        ctx.account.id,
        ctx.apiKey.id,
        {
          userId: ctx.user.clientUserId,
          units: 5n,
          idempotencyKey: "queued-across-boundary",
        },
        { admissionTimestamp: () => admission }
      );

      await waitForQueuedAdmission(pending, 1);

      // Boundary crossed while the request was queued.
      admission = "2026-11-01T00:00:00.500Z";
      await release();

      const res = await pending;
      expect(res.decision).toBe("accepted");
      expect(res.periodStart).toBe("2026-11-01");
      expect(res.accountRemaining).toBe(ctx.accountPlan.monthlyAllowance - 5n);
      expect(res.userRemaining).toBe(ctx.userPlan.monthlyAllowance - 5n);
    });

    const db = getTestDb();

    // Only November periods exist: the October side never consumed anything
    // for this request (the holder's rolled-back row is gone).
    const counters = await db
      .select({
        periodStart: usageCounters.periodStart,
        userId: usageCounters.userId,
        counter: usageCounters.counter,
      })
      .from(usageCounters)
      .where(eq(usageCounters.accountId, BigInt(ctx.account.id)))
      .execute();

    expect(counters).toHaveLength(2);
    expect(counters.every((c) => c.periodStart === "2026-11-01")).toBe(true);
    expect(counters.find((c) => c.userId === null)?.counter).toBe(5n);
    expect(counters.find((c) => c.userId !== null)?.counter).toBe(5n);

    const [record] = await db
      .select({
        periodStart: usageRequests.periodStart,
        createdAt: usageRequests.createdAt,
        decision: usageRequests.decision,
      })
      .from(usageRequests)
      .where(eq(usageRequests.accountId, BigInt(ctx.account.id)))
      .execute();

    expect(record.decision).toBe("accepted");
    expect(record.periodStart).toBe("2026-11-01");
    expect(record.createdAt.toISOString()).toBe("2026-11-01T00:00:00.500Z");
    expect(formatDateForDb(getUtcMonthStart(record.createdAt))).toBe("2026-11-01");
  });

  it("admits two requests queued across the boundary into the new month without double counting", async () => {
    const ctx = await setupBasicTestContext();

    let admission = "2026-10-31T23:59:59.500Z";

    await withHeldAdmissionLock(ctx.account.id, "2026-10-01", async (release) => {
      const first = makeUsageRequest(
        ctx.account.id,
        ctx.apiKey.id,
        { units: 3n, idempotencyKey: "queued-concurrent-1" },
        { admissionTimestamp: () => admission }
      );
      const second = makeUsageRequest(
        ctx.account.id,
        ctx.apiKey.id,
        { units: 4n, idempotencyKey: "queued-concurrent-2" },
        { admissionTimestamp: () => admission }
      );

      await waitForQueuedAdmission(first, 1);
      await waitForQueuedAdmission(second, 2);

      admission = "2026-11-01T00:00:00.500Z";
      await release();

      const [res1, res2] = await Promise.all([first, second]);
      expect(res1.decision).toBe("accepted");
      expect(res2.decision).toBe("accepted");
      expect(res1.periodStart).toBe("2026-11-01");
      expect(res2.periodStart).toBe("2026-11-01");
      // Post-lock admission order is not guaranteed, so per-request remainings
      // are not asserted individually; the counter sum below proves both
      // landed once, in the new period, with no double counting.
    });

    const db = getTestDb();
    const counters = await db
      .select({ periodStart: usageCounters.periodStart, counter: usageCounters.counter })
      .from(usageCounters)
      .where(and(eq(usageCounters.accountId, BigInt(ctx.account.id)), isNull(usageCounters.userId)))
      .execute();

    expect(counters).toHaveLength(1);
    expect(counters[0]?.periodStart).toBe("2026-11-01");
    expect(counters[0]?.counter).toBe(7n);
  });

  it("replays a request committed in the previous month with its original period and does not touch the new period", async () => {
    const ctx = await setupBasicTestContext();

    let admission = "2026-10-31T23:59:59.999Z";

    const original = await makeUsageRequest(
      ctx.account.id,
      ctx.apiKey.id,
      { units: 4n, idempotencyKey: "replay-across-boundary" },
      { admissionTimestamp: () => admission }
    );
    expect(original.decision).toBe("accepted");
    expect(original.periodStart).toBe("2026-10-01");

    admission = "2026-11-01T00:00:01.000Z";

    const replay = await makeUsageRequest(
      ctx.account.id,
      ctx.apiKey.id,
      { units: 4n, idempotencyKey: "replay-across-boundary" },
      { admissionTimestamp: () => admission }
    );
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

  it("derives the period from the admission clock source, not the process wall clock", async () => {
    const ctx = await setupBasicTestContext();

    const pool = getTestPool();
    const dbMonth = async (): Promise<string> => {
      const res = await pool.query(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM') AS month`
      );
      return res.rows[0].month as string;
    };

    const monthBefore = await dbMonth();

    // Shift only the JS clock to a different month than the database clock.
    // A period computed from `new Date()` is attributed to the wrong month.
    const shifted = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(shifted);

    const res = await makeUsageRequest(ctx.account.id, ctx.apiKey.id, {
      units: 5n,
      idempotencyKey: "clock-source-default",
    });
    expect(res.decision).toBe("accepted");

    vi.useRealTimers();

    const monthAfter = await dbMonth();
    expect([monthBefore, monthAfter]).toContain(res.periodStart.slice(0, 7));

    const record = await getTestDb()
      .select({
        periodStart: usageRequests.periodStart,
        createdAt: usageRequests.createdAt,
      })
      .from(usageRequests)
      .where(eq(usageRequests.accountId, BigInt(ctx.account.id)))
      .execute();
    expect(record).toHaveLength(1);
    expect(formatDateForDb(getUtcMonthStart(record[0]!.createdAt))).toBe(record[0]!.periodStart);
  });
});
