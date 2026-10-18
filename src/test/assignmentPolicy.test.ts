import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, getTestPool } from "./setup.js";
import { accounts, users, plans, planAssignments, usageCounters } from "../db/schema/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { createApiKey } from "../application/auth/apiKeyService.js";
import { createPlan, updatePlan, deletePlan } from "../application/plans/planService.js";
import { createAssignment } from "../application/plans/assignmentService.js";
import { getCurrentAssignments } from "../application/plans/assignmentHistoryService.js";
import { processUsageRequest } from "../application/usage/usageService.js";
import { getUtcMonthStart } from "../domain/date.js";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../config/index.js";
import type { PoolClient } from "pg";

async function createTestAccount(name: string) {
  const db = getTestDb();
  const [account] = await db
    .insert(accounts)
    .values({ name })
    .returning({ id: accounts.id, name: accounts.name })
    .execute();
  return { id: Number(account.id), name: account.name };
}

async function createTestUser(accountId: number, clientUserId: string) {
  const db = getTestDb();
  const [user] = await db
    .insert(users)
    .values({ accountId: BigInt(accountId), clientUserId })
    .returning({ id: users.id, clientUserId: users.clientUserId })
    .execute();
  return { id: Number(user.id), clientUserId: user.clientUserId };
}

async function createTestPlan(
  accountId: number,
  name: string,
  type: "account" | "user",
  monthlyAllowance: bigint,
  maxUnitsPerRequest: bigint
) {
  const plan = await createPlan(
    { name, type, monthlyAllowance, maxUnitsPerRequest },
    accountId
  );
  return {
    id: plan.id,
    name: plan.name,
    type: plan.type,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
  };
}

async function createTestApiKey(accountId: number, name?: string) {
  const result = await createApiKey(accountId, name);
  return {
    id: result.id,
    prefix: result.prefix,
    key: result.key,
  };
}

async function seedInitialAccountAssignment(accountId: number, planId: number) {
  const db = getTestDb();
  await db
    .delete(planAssignments)
    .where(and(
      eq(planAssignments.accountId, BigInt(accountId)),
      isNull(planAssignments.userId)
    ))
    .execute();
  await createAssignment(accountId, { planId, effectiveFrom: getUtcMonthStart() }, accountId);
}

async function seedInitialUserAssignment(accountId: number, userId: string, planId: number) {
  await createAssignment(accountId, { userId, planId, effectiveFrom: getUtcMonthStart() }, accountId);
}

async function setupAccountContext() {
  const account = await createTestAccount("Policy Account");
  const apiKey = await createTestApiKey(account.id, "Policy Key");
  const basePlan = await createTestPlan(account.id, "Base", "account", 1000n, MAX_UNITS_PER_REQUEST_BIGINT);
  await seedInitialAccountAssignment(account.id, basePlan.id);
  return { account, apiKey, basePlan };
}

async function setupUserContext() {
  const context = await setupAccountContext();
  const user = await createTestUser(context.account.id, "policy-user");
  const userPlan = await createTestPlan(context.account.id, "User Base", "user", 100n, 100n);
  await seedInitialUserAssignment(context.account.id, user.clientUserId, userPlan.id);
  return { ...context, user, userPlan };
}

async function getAccountAssignments(accountId: number) {
  const db = getTestDb();
  return db
    .select()
    .from(planAssignments)
    .where(and(
      eq(planAssignments.accountId, BigInt(accountId)),
      isNull(planAssignments.userId)
    ))
    .execute();
}

async function getUserAssignments(accountId: number, userId: number) {
  const db = getTestDb();
  return db
    .select()
    .from(planAssignments)
    .where(and(
      eq(planAssignments.accountId, BigInt(accountId)),
      eq(planAssignments.userId, BigInt(userId))
    ))
    .execute();
}

function countOpenEnded(rows: { effectiveTo: Date | null }[]): number {
  return rows.filter((r) => r.effectiveTo === null).length;
}

function countPending(rows: { effectiveFrom: Date; effectiveTo: Date | null }[], now: Date): number {
  return rows.filter((r) => r.effectiveFrom > now && r.effectiveTo === null).length;
}

async function getAccountCounter(accountId: number): Promise<bigint> {
  const db = getTestDb();
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(and(
      eq(usageCounters.accountId, BigInt(accountId)),
      isNull(usageCounters.userId)
    ))
    .execute();
  return row?.counter ?? 0n;
}

describe("Assignment policy (upgrade supersession, pending uniqueness)", () => {
  beforeEach(() => {
    // Tables truncated in setup afterEach
  });

  describe("Account-level", () => {
    it("upgrade supersedes a pending downgrade and takes effect immediately", async () => {
      const { account, apiKey, basePlan } = await setupAccountContext();

      await processUsageRequest(account.id, {
        units: 100n,
        idempotencyKey: "policy-1-pre",
      }, apiKey.id);

      const counterBefore = await getAccountCounter(account.id);
      expect(counterBefore).toBe(100n);

      const pendingPlan = await createTestPlan(account.id, "Pending Low", "account", 200n, MAX_UNITS_PER_REQUEST_BIGINT);
      await createAssignment(account.id, { planId: pendingPlan.id }, account.id);

      const upgradePlan = await createTestPlan(account.id, "Upgrade High", "account", 5000n, MAX_UNITS_PER_REQUEST_BIGINT);
      const assignment = await createAssignment(account.id, { planId: upgradePlan.id }, account.id);

      expect(assignment.isCurrent).toBe(true);
      expect(assignment.planId).toBe(upgradePlan.id);

      const rows = await getAccountAssignments(account.id);
      expect(countOpenEnded(rows)).toBe(1);
      expect(countPending(rows, new Date())).toBe(0);

      const current = await getCurrentAssignments(account.id);
      expect(current.account?.planId).toBe(upgradePlan.id);

      const counterAfter = await getAccountCounter(account.id);
      expect(counterAfter).toBe(counterBefore);

      const usage = await processUsageRequest(account.id, {
        units: 100n,
        idempotencyKey: "policy-1-post",
      }, apiKey.id);
      expect(usage.decision).toBe("accepted");
      expect(usage.accountRemaining.toString()).toBe("4800");
    });

    it("newest downgrade replaces the pending downgrade (exactly one pending)", async () => {
      const { account, basePlan } = await setupAccountContext();

      const firstPending = await createTestPlan(account.id, "First Pending", "account", 200n, MAX_UNITS_PER_REQUEST_BIGINT);
      const secondPending = await createTestPlan(account.id, "Second Pending", "account", 150n, MAX_UNITS_PER_REQUEST_BIGINT);

      const a = await createAssignment(account.id, { planId: firstPending.id }, account.id);
      const b = await createAssignment(account.id, { planId: secondPending.id }, account.id);

      expect(a.isCurrent).toBe(false);
      expect(b.isCurrent).toBe(false);
      expect(b.planId).toBe(secondPending.id);

      const rows = await getAccountAssignments(account.id);
      expect(countOpenEnded(rows)).toBe(1);
      expect(countPending(rows, new Date())).toBe(1);

      const pendingRow = rows.find((r) => r.effectiveTo === null && r.effectiveFrom > new Date());
      expect(pendingRow).toBeDefined();
      expect(Number(pendingRow!.planId)).toBe(secondPending.id);

      const current = await getCurrentAssignments(account.id);
      expect(current.account?.planId).toBe(basePlan.id);
    });

    it("upgrade then downgrade in the same month keeps upgraded plan until next UTC month", async () => {
      const { account, apiKey } = await setupAccountContext();

      const upgradePlan = await createTestPlan(account.id, "Mid Upgrade", "account", 5000n, MAX_UNITS_PER_REQUEST_BIGINT);
      await createAssignment(account.id, { planId: upgradePlan.id }, account.id);

      const downgradePlan = await createTestPlan(account.id, "After Upgrade Low", "account", 300n, MAX_UNITS_PER_REQUEST_BIGINT);
      const downgraded = await createAssignment(account.id, { planId: downgradePlan.id }, account.id);

      expect(downgraded.isCurrent).toBe(false);

      const current = await getCurrentAssignments(account.id);
      expect(current.account?.planId).toBe(upgradePlan.id);

      const usage = await processUsageRequest(account.id, {
        units: 50n,
        idempotencyKey: "policy-3-pre-boundary",
      }, apiKey.id);
      expect(usage.decision).toBe("accepted");
      expect(usage.accountRemaining.toString()).toBe("4950");

      const rows = await getAccountAssignments(account.id);
      expect(countOpenEnded(rows)).toBe(1);
      expect(countPending(rows, new Date())).toBe(1);
    });

    it("client effectiveFrom is ignored when a current assignment exists (upgrade starts now)", async () => {
      const { account } = await setupAccountContext();
      const upgradePlan = await createTestPlan(account.id, "Ignore Past Date", "account", 5000n, MAX_UNITS_PER_REQUEST_BIGINT);

      const past = new Date(Date.UTC(2020, 0, 1));
      const assignment = await createAssignment(
        account.id,
        { planId: upgradePlan.id, effectiveFrom: past },
        account.id
      );

      expect(assignment.isCurrent).toBe(true);
      expect(assignment.planId).toBe(upgradePlan.id);
      // BR-14: effectiveFrom is a full ISO instant stamped at execution time
      // (after locks), never the client's past date.
      const effectiveFrom = new Date(assignment.effectiveFrom);
      expect(effectiveFrom.toISOString()).toBe(assignment.effectiveFrom);
      expect(effectiveFrom.getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
      expect(effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    it("first assignment still honors past effectiveFrom (bootstrap style)", async () => {
      const account = await createTestAccount("Bootstrap Style");
      const plan = await createTestPlan(account.id, "First Plan", "account", 1000n, MAX_UNITS_PER_REQUEST_BIGINT);

      const monthStart = getUtcMonthStart();
      const assignment = await createAssignment(
        account.id,
        { planId: plan.id, effectiveFrom: monthStart },
        account.id
      );

      expect(assignment.effectiveFrom).toBe(monthStart.toISOString());
      expect(assignment.isCurrent).toBe(true);
    });

    it("cannot delete or deactivate a currently assigned custom plan", async () => {
      const { account } = await setupAccountContext();
      const custom = await createTestPlan(account.id, "In Use Custom", "account", 800n, MAX_UNITS_PER_REQUEST_BIGINT);

      await createAssignment(account.id, { planId: custom.id }, account.id);

      await expect(deletePlan(custom.id, account.id)).rejects.toThrow(
        "Plan is assigned and cannot be deleted or deactivated"
      );

      await expect(
        updatePlan(custom.id, { isActive: false }, account.id)
      ).rejects.toThrow("Plan is assigned and cannot be deleted or deactivated");

      await expect(
        updatePlan(custom.id, { monthlyAllowance: 900n }, account.id)
      ).resolves.toBeDefined();
    });

    it("cannot delete a plan that is only pending (scheduled downgrade)", async () => {
      const { account } = await setupAccountContext();
      const pendingPlan = await createTestPlan(account.id, "Pending Only", "account", 100n, MAX_UNITS_PER_REQUEST_BIGINT);

      await createAssignment(account.id, { planId: pendingPlan.id }, account.id);

      await expect(deletePlan(pendingPlan.id, account.id)).rejects.toThrow(
        "Plan is assigned and cannot be deleted or deactivated"
      );
    });

    it("can delete an unassigned custom plan", async () => {
      const { account } = await setupAccountContext();
      const unused = await createTestPlan(account.id, "Unused Custom", "account", 700n, MAX_UNITS_PER_REQUEST_BIGINT);

      await expect(deletePlan(unused.id, account.id)).resolves.toBeUndefined();
    });
  });

  describe("User-level", () => {
    it("upgrade supersedes pending user downgrade without affecting the account timeline", async () => {
      const { account, user, apiKey, basePlan, userPlan } = await setupUserContext();

      await processUsageRequest(account.id, {
        userId: user.clientUserId,
        units: 10n,
        idempotencyKey: "policy-u1-pre",
      }, apiKey.id);

      const pendingUserPlan = await createTestPlan(account.id, "User Pending Low", "user", 20n, 20n);
      await createAssignment(account.id, { userId: user.clientUserId, planId: pendingUserPlan.id }, account.id);

      const upgradeUserPlan = await createTestPlan(account.id, "User Upgrade High", "user", 500n, 500n);
      const assignment = await createAssignment(
        account.id,
        { userId: user.clientUserId, planId: upgradeUserPlan.id },
        account.id
      );

      expect(assignment.isCurrent).toBe(true);
      expect(assignment.planId).toBe(upgradeUserPlan.id);

      const userRows = await getUserAssignments(account.id, user.id);
      expect(countOpenEnded(userRows)).toBe(1);
      expect(countPending(userRows, new Date())).toBe(0);

      const accountRows = await getAccountAssignments(account.id);
      expect(countOpenEnded(accountRows)).toBe(1);
      expect(Number(accountRows[0].planId)).toBe(basePlan.id);

      const current = await getCurrentAssignments(account.id);
      expect(current.account?.planId).toBe(basePlan.id);
      expect(current.users.find((u) => u.userId === user.id)?.planId).toBe(upgradeUserPlan.id);

      const usage = await processUsageRequest(account.id, {
        userId: user.clientUserId,
        units: 10n,
        idempotencyKey: "policy-u1-post",
      }, apiKey.id);
      expect(usage.decision).toBe("accepted");
      expect(usage.userRemaining!.toString()).toBe("480");
    });

    it("newest user downgrade replaces the pending user downgrade only", async () => {
      const { account, user, basePlan, userPlan } = await setupUserContext();

      const first = await createTestPlan(account.id, "U First Pending", "user", 40n, 40n);
      const second = await createTestPlan(account.id, "U Second Pending", "user", 30n, 30n);

      await createAssignment(account.id, { userId: user.clientUserId, planId: first.id }, account.id);
      const b = await createAssignment(account.id, { userId: user.clientUserId, planId: second.id }, account.id);

      expect(b.isCurrent).toBe(false);

      const userRows = await getUserAssignments(account.id, user.id);
      expect(countOpenEnded(userRows)).toBe(1);
      expect(countPending(userRows, new Date())).toBe(1);
      expect(Number(userRows.find((r) => r.effectiveTo === null)!.planId)).toBe(second.id);

      const current = await getCurrentAssignments(account.id);
      expect(current.account?.planId).toBe(basePlan.id);
      expect(current.users.find((u) => u.userId === user.id)?.planId).toBe(userPlan.id);
    });
  });

  describe("Assign vs plan delete/deactivate concurrency", () => {
    async function lockPlanRow(planId: number): Promise<PoolClient> {
      const client = await getTestPool().connect();
      await client.query("BEGIN");
      await client.query("SELECT id FROM plans WHERE id = $1 FOR UPDATE", [planId]);
      return client;
    }

    // Always releases the blocker connection, even if the body throws.
    async function withLockedPlan<T>(planId: number, fn: (blocker: PoolClient) => Promise<T>): Promise<T> {
      const blocker = await lockPlanRow(planId);
      try {
        return await fn(blocker);
      } finally {
        try {
          await blocker.query("ROLLBACK");
        } catch {
          // already committed inside fn
        }
        blocker.release();
      }
    }

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Polls pg_stat_activity until at least `min` backends are blocked on a
    // row lock whose statement matches `pattern`. This proves the concurrent
    // transaction is genuinely waiting, instead of trusting that a fixed
    // sleep was long enough for it to reach the lock.
    async function waitForWaiters(pattern: string, min = 1, timeoutMs = 15000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      let seen = 0;
      while (Date.now() < deadline) {
        const res = await getTestPool().query(
          `SELECT count(*)::int AS n
             FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND pid <> pg_backend_pid()
              AND query ILIKE $1`,
          [`%${pattern}%`]
        );
        seen = res.rows[0].n as number;
        if (seen >= min) return seen;
        await sleep(25);
      }
      throw new Error(
        `timed out waiting for ${min} lock waiter(s) matching ${JSON.stringify(pattern)} (last saw ${seen})`
      );
    }

    async function getPlanRow(planId: number) {
      const [row] = await getTestDb()
        .select()
        .from(plans)
        .where(eq(plans.id, BigInt(planId)))
        .execute();
      return row;
    }

    async function countAssignmentsForPlan(planId: number): Promise<number> {
      const rows = await getTestDb()
        .select()
        .from(planAssignments)
        .where(eq(planAssignments.planId, BigInt(planId)))
        .execute();
      return rows.length;
    }

    it("assign vs delete: concurrent ops never leave an assignment on a deleted plan", async () => {
      const { account } = await setupAccountContext();
      const plan = await createTestPlan(account.id, "Race Delete", "account", 400n, MAX_UNITS_PER_REQUEST_BIGINT);

      // Hold the plan row lock so both service transactions block on
      // FOR UPDATE, then release them together for a real race.
      const [assignResult, deleteResult] = await withLockedPlan(plan.id, async (blocker) => {
        const assignPromise = createAssignment(account.id, { planId: plan.id }, account.id);
        const deletePromise = deletePlan(plan.id, account.id);

        // Both must be waiting on the blocker lock before we release it.
        await waitForWaiters("FOR UPDATE", 2);
        await blocker.query("COMMIT");

        return Promise.allSettled([assignPromise, deletePromise]);
      });

      const assignOk = assignResult.status === "fulfilled";
      const deleteOk = deleteResult.status === "fulfilled";

      // Exactly one side may win; never both.
      expect(assignOk !== deleteOk).toBe(true);

      const planRow = await getPlanRow(plan.id);
      const assignmentCount = await countAssignmentsForPlan(plan.id);

      if (deleteOk) {
        // Delete won: plan soft-deleted, no assignment may reference it.
        expect(assignOk).toBe(false);
        expect(assignResult.status).toBe("rejected");
        expect(planRow.deletedAt).not.toBeNull();
        expect(planRow.isActive).toBe(false);
        expect(assignmentCount).toBe(0);
      } else {
        // Assign won: assignment exists, plan must still be active/undeleted.
        expect(deleteOk).toBe(false);
        expect(deleteResult.status).toBe("rejected");
        expect((deleteResult as PromiseRejectedResult).reason?.message).toContain(
          "Plan is assigned and cannot be deleted or deactivated"
        );
        expect(planRow.deletedAt).toBeNull();
        expect(planRow.isActive).toBe(true);
        expect(assignmentCount).toBe(1);
      }
    }, 30000);

    it("READ COMMITTED re-check: assign waiting on plan lock fails after a concurrent soft-delete commits", async () => {
      const { account } = await setupAccountContext();
      const plan = await createTestPlan(account.id, "EPQ Soft Delete", "account", 400n, MAX_UNITS_PER_REQUEST_BIGINT);

      // Start the assign first so it is the FOR UPDATE waiter, then
      // soft-delete the plan while it waits. When the blocker commits,
      // PostgreSQL must re-evaluate is_active/deleted_at on the updated row
      // instead of returning the stale pre-delete version.
      await withLockedPlan(plan.id, async (blocker) => {
        const assignPromise = createAssignment(account.id, { planId: plan.id }, account.id);
        // The assign transaction must be waiting on the plan row lock before
        // the mutation below, so the EPQ re-check actually happens.
        await waitForWaiters("FOR UPDATE", 1);

        await blocker.query(
          "UPDATE plans SET is_active = false, deleted_at = now() WHERE id = $1",
          [plan.id]
        );
        await blocker.query("COMMIT");

        await expect(assignPromise).rejects.toThrow("Plan not found or inactive");
      });

      expect(await countAssignmentsForPlan(plan.id)).toBe(0);
      const planRow = await getPlanRow(plan.id);
      expect(planRow.deletedAt).not.toBeNull();
      expect(planRow.isActive).toBe(false);
    }, 30000);

    it("READ COMMITTED re-check: assign waiting on plan lock fails after a concurrent deactivation commits", async () => {
      const { account } = await setupAccountContext();
      const plan = await createTestPlan(account.id, "EPQ Deactivate", "account", 400n, MAX_UNITS_PER_REQUEST_BIGINT);

      await withLockedPlan(plan.id, async (blocker) => {
        const assignPromise = createAssignment(account.id, { planId: plan.id }, account.id);
        await waitForWaiters("FOR UPDATE", 1);

        // Same row update deactivate performs; is_active flips while assign waits.
        await blocker.query("UPDATE plans SET is_active = false WHERE id = $1", [plan.id]);
        await blocker.query("COMMIT");

        await expect(assignPromise).rejects.toThrow("Plan not found or inactive");
      });

      expect(await countAssignmentsForPlan(plan.id)).toBe(0);
      const planRow = await getPlanRow(plan.id);
      expect(planRow.isActive).toBe(false);
      expect(planRow.deletedAt).toBeNull();
    }, 30000);

    it("assign then delete: delete fails with 409 and assignment remains usable", async () => {
      const { account, apiKey } = await setupAccountContext();
      const plan = await createTestPlan(account.id, "Sequential Delete", "account", 400n, MAX_UNITS_PER_REQUEST_BIGINT);

      // Deterministic order: assign completes fully, then delete.
      // Still hold the plan lock across the assign to prove FOR UPDATE path works.
      await withLockedPlan(plan.id, async (blocker) => {
        const assignPromise = createAssignment(account.id, { planId: plan.id }, account.id);
        await waitForWaiters("FOR UPDATE", 1);
        await blocker.query("COMMIT");
        await assignPromise;
      });

      await expect(deletePlan(plan.id, account.id)).rejects.toThrow(
        "Plan is assigned and cannot be deleted or deactivated"
      );

      const planRow = await getPlanRow(plan.id);
      expect(planRow.deletedAt).toBeNull();
      expect(planRow.isActive).toBe(true);
      expect(await countAssignmentsForPlan(plan.id)).toBe(1);

      const usage = await processUsageRequest(account.id, {
        units: 10n,
        idempotencyKey: "race-delete-assign-still-works",
      }, apiKey.id);
      expect(usage.decision).toBe("accepted");
    }, 30000);

    it("delete then assign: assign fails and no assignment row is created", async () => {
      const { account } = await setupAccountContext();
      const plan = await createTestPlan(account.id, "Sequential Assign After Delete", "account", 400n, MAX_UNITS_PER_REQUEST_BIGINT);

      // Delete holds the plan lock for its whole transaction; assign starts
      // after delete commits and must re-validate (plan gone).
      await withLockedPlan(plan.id, async (blocker) => {
        const deletePromise = deletePlan(plan.id, account.id);
        await waitForWaiters("FOR UPDATE", 1);
        await blocker.query("COMMIT");
        await deletePromise;
      });

      await expect(
        createAssignment(account.id, { planId: plan.id }, account.id)
      ).rejects.toThrow("Plan not found or inactive");

      expect(await countAssignmentsForPlan(plan.id)).toBe(0);
      const planRow = await getPlanRow(plan.id);
      expect(planRow.deletedAt).not.toBeNull();
    }, 30000);

    it("assign vs deactivate: concurrent ops never deactivate a plan that ends up assigned", async () => {
      const { account } = await setupAccountContext();
      const plan = await createTestPlan(account.id, "Race Deactivate", "account", 400n, MAX_UNITS_PER_REQUEST_BIGINT);

      const [assignResult, deactivateResult] = await withLockedPlan(plan.id, async (blocker) => {
        const assignPromise = createAssignment(account.id, { planId: plan.id }, account.id);
        const deactivatePromise = updatePlan(plan.id, { isActive: false }, account.id);

        await waitForWaiters("FOR UPDATE", 2);
        await blocker.query("COMMIT");

        return Promise.allSettled([assignPromise, deactivatePromise]);
      });

      const assignOk = assignResult.status === "fulfilled";
      const deactivateOk = deactivateResult.status === "fulfilled";
      expect(assignOk !== deactivateOk).toBe(true);

      const planRow = await getPlanRow(plan.id);
      const assignmentCount = await countAssignmentsForPlan(plan.id);

      if (deactivateOk) {
        expect(assignOk).toBe(false);
        expect(planRow.isActive).toBe(false);
        expect(assignmentCount).toBe(0);
      } else {
        expect(rejectionMessage(deactivateResult)).toContain(
          "Plan is assigned and cannot be deleted or deactivated"
        );
        expect(planRow.isActive).toBe(true);
        expect(assignmentCount).toBe(1);
      }
    }, 30000);

    it("BR-13: effectiveFrom is stamped after the assignment-row lock wait, never backdated", async () => {
      const { account } = await setupAccountContext();
      const higherPlan = await createTestPlan(account.id, "Post Lock Upgrade", "account", 5000n, MAX_UNITS_PER_REQUEST_BIGINT);

      const blocker = await getTestPool().connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM plan_assignments WHERE account_id = $1 AND user_id IS NULL FOR UPDATE",
        [account.id]
      );

      try {
        const assignPromise = createAssignment(account.id, { planId: higherPlan.id }, account.id);

        // The assign transaction must be blocked on our row lock before we
        // measure the release time — otherwise the test proves nothing.
        await waitForWaiters("FOR UPDATE", 1);

        await sleep(100); // push wall-clock forward so a pre-wait stamp would differ
        const releasedAt = Date.now();
        await blocker.query("COMMIT");

        const assignment = await assignPromise;

        // Upgrade takes effect immediately: stamped with a clock read AFTER
        // the lock was acquired (now >= release), not the `now` captured
        // before the wait (which would be < releasedAt = the BR-13 bug).
        expect(new Date(assignment.effectiveFrom).getTime()).toBeGreaterThanOrEqual(releasedAt);
        expect(assignment.isCurrent).toBe(true);
        expect(assignment.planId).toBe(higherPlan.id);
      } finally {
        try {
          await blocker.query("ROLLBACK");
        } catch {
          // already committed above
        }
        blocker.release();
      }
    }, 30000);

    it("CON-04: classification locks the current plan row before comparing allowances", async () => {
      const { account, basePlan } = await setupAccountContext();
      const targetPlan = await createTestPlan(account.id, "Concurrent Allowance Target", "account", 2000n, MAX_UNITS_PER_REQUEST_BIGINT);

      await withLockedPlan(basePlan.id, async (blocker) => {
        const assignPromise = createAssignment(account.id, { planId: targetPlan.id }, account.id);

        // Pre-fix this read was a plain SELECT: no wait, timeout here.
        // Post-fix the current plan row is locked FOR UPDATE while the
        // upgrade/downgrade decision compares allowances.
        await waitForWaiters("FOR UPDATE", 1, 10000);

        await blocker.query("COMMIT");
        const assignment = await assignPromise;

        expect(assignment.planId).toBe(targetPlan.id);
        expect(assignment.isCurrent).toBe(true);
      });
    }, 30000);

    function rejectionMessage(result: PromiseSettledResult<unknown>): string {
      if (result.status !== "rejected") {
        throw new Error("expected rejection");
      }
      return (result.reason as Error).message;
    }
  });
});
