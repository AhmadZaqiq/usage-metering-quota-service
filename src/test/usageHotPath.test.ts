import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb } from "./setup.js";
import { setupBasicTestContext, makeUsageRequest } from "./utils.js";
import { apiKeys, plans } from "../db/schema/index.js";
import {
  selectCurrentPlanQuotaByAccount,
  selectCurrentPlanQuotaByUser,
  selectCurrentAssignmentByAccount,
  selectCurrentAssignmentByUser,
  selectPlanByCriteria,
} from "../infrastructure/repositories/assignmentRepository.js";
import { LAST_USED_MIN_INTERVAL_S } from "../infrastructure/repositories/apiKeyRepository.js";

describe("usage hot path: fused assignment+plan lookup", () => {
  it("returns the same account-scoped quota as the separate assignment + plan pair", async () => {
    const context = await setupBasicTestContext();
    const db = getTestDb();

    const fused = await selectCurrentPlanQuotaByAccount(db, BigInt(context.account.id));
    const assignment = await selectCurrentAssignmentByAccount(db, BigInt(context.account.id));
    const plan = assignment ? await selectPlanByCriteria(db, assignment.planId) : null;

    expect(fused).not.toBeNull();
    expect(assignment).not.toBeNull();
    expect(plan).not.toBeNull();
    expect(fused!.assignmentId).toBe(assignment!.id);
    expect(fused!.planId).toBe(plan!.id);
    expect(fused!.monthlyAllowance).toBe(plan!.monthlyAllowance);
    expect(fused!.maxUnitsPerRequest).toBe(plan!.maxUnitsPerRequest);
  });

  it("returns the same user-scoped quota as the separate assignment + plan pair", async () => {
    const context = await setupBasicTestContext();
    const db = getTestDb();
    const userId = BigInt(context.user.id);

    const fused = await selectCurrentPlanQuotaByUser(db, userId);
    const assignment = await selectCurrentAssignmentByUser(db, userId);
    const plan = assignment ? await selectPlanByCriteria(db, assignment.planId) : null;

    expect(fused).not.toBeNull();
    expect(assignment).not.toBeNull();
    expect(plan).not.toBeNull();
    expect(fused!.assignmentId).toBe(assignment!.id);
    expect(fused!.planId).toBe(plan!.id);
    expect(fused!.monthlyAllowance).toBe(plan!.monthlyAllowance);
    expect(fused!.maxUnitsPerRequest).toBe(plan!.maxUnitsPerRequest);
  });

  it("collapses 'assignment exists but plan unusable' to null (usage path fails closed with 409)", async () => {
    const context = await setupBasicTestContext();
    const db = getTestDb();

    // Deactivate the assigned account plan: the old pair returned
    // (assignment, null-plan) and the usage path threw 409; the fused
    // lookup must report no usable quota for the same state.
    await db.update(plans).set({ isActive: false }).where(eq(plans.id, BigInt(context.accountPlan.id))).execute();

    const fused = await selectCurrentPlanQuotaByAccount(db, BigInt(context.account.id));
    const assignment = await selectCurrentAssignmentByAccount(db, BigInt(context.account.id));
    const plan = assignment ? await selectPlanByCriteria(db, assignment.planId) : null;

    expect(assignment).not.toBeNull();
    expect(plan).toBeNull();
    expect(fused).toBeNull();
  });

  it("keeps the end-to-end usage decision unchanged (accepted with correct remainings)", async () => {
    const context = await setupBasicTestContext();

    const decision = await makeUsageRequest(context.account.id, context.apiKey.id, {
      userId: context.user.clientUserId,
      units: 5n,
      idempotencyKey: "hotpath-e2e-1",
    });

    expect(decision.decision).toBe("accepted");
    // Account plan allowance 1000, user plan allowance 100.
    expect(decision.accountRemaining).toBe(995n);
    expect(decision.userRemaining).toBe(95n);
  });
});

describe("usage hot path: throttled api-key last-used stamp", () => {
  async function readStamp(keyId: number): Promise<Date | null> {
    const db = getTestDb();
    const rows = await db
      .select({ lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, BigInt(keyId)))
      .execute();
    return rows[0]?.lastUsedAt ?? null;
  }

  it("stamps on first use, refreshes after the interval, and skips recent rewrites", async () => {
    const context = await setupBasicTestContext();
    const db = getTestDb();

    // First use: NULL stamp must be written.
    await makeUsageRequest(context.account.id, context.apiKey.id, {
      units: 1n,
      idempotencyKey: "stamp-1",
    });
    const first = await readStamp(context.apiKey.id);
    expect(first).not.toBeNull();

    // Recent stamp: a second use inside the window must not rewrite it.
    const recent = new Date(Date.now() - 1_000);
    await db
      .update(apiKeys)
      .set({ lastUsedAt: recent })
      .where(eq(apiKeys.id, BigInt(context.apiKey.id)))
      .execute();
    await makeUsageRequest(context.account.id, context.apiKey.id, {
      units: 1n,
      idempotencyKey: "stamp-2",
    });
    expect(await readStamp(context.apiKey.id)).toEqual(recent);

    // Stale stamp: a use after the interval refreshes it.
    const stale = new Date(Date.now() - (LAST_USED_MIN_INTERVAL_S + 30) * 1_000);
    await db
      .update(apiKeys)
      .set({ lastUsedAt: stale })
      .where(eq(apiKeys.id, BigInt(context.apiKey.id)))
      .execute();
    await makeUsageRequest(context.account.id, context.apiKey.id, {
      units: 1n,
      idempotencyKey: "stamp-3",
    });
    const refreshed = await readStamp(context.apiKey.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.getTime()).toBeGreaterThan(stale.getTime());
  });
});
