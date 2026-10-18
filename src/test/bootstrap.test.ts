import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrap } from "../scripts/bootstrap.js";
import { getTestDb } from "./setup.js";
import { accounts, apiKeys, plans, planAssignments, usageCounters } from "../db/schema/index.js";
import { and, eq, isNull } from "drizzle-orm";
import { processUsageRequest } from "../application/usage/usageService.js";

const ORIGINAL_BOOTSTRAP_ACCOUNT_NAME = process.env.BOOTSTRAP_ACCOUNT_NAME;
const ORIGINAL_BOOTSTRAP_API_KEY_NAME = process.env.BOOTSTRAP_API_KEY_NAME;

async function findAccount(name: string) {
  const db = getTestDb();
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.name, name))
    .limit(1)
    .execute();
  return account ? { id: Number(account.id), name: account.name } : null;
}

async function findSystemPlan(name: string, type: string) {
  const db = getTestDb();
  const [plan] = await db
    .select({ id: plans.id, name: plans.name, type: plans.type, ownerAccountId: plans.ownerAccountId })
    .from(plans)
    .where(and(isNull(plans.ownerAccountId), eq(plans.name, name), eq(plans.type, type), isNull(plans.deletedAt)))
    .limit(1)
    .execute();
  return plan;
}

async function countSystemPlans() {
  const db = getTestDb();
  const rows = await db
    .select({ id: plans.id })
    .from(plans)
    .where(isNull(plans.ownerAccountId))
    .execute();
  return rows.length;
}

async function findCurrentAccountAssignment(accountId: number) {
  const db = getTestDb();
  const [assignment] = await db
    .select({ id: planAssignments.id, planId: planAssignments.planId })
    .from(planAssignments)
    .where(
      and(
        eq(planAssignments.accountId, BigInt(accountId)),
        isNull(planAssignments.userId),
        isNull(planAssignments.effectiveTo)
      )
    )
    .limit(1)
    .execute();
  return assignment;
}

async function findApiKey(accountId: number) {
  const db = getTestDb();
  const [key] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.accountId, BigInt(accountId)))
    .limit(1)
    .execute();
  return key ? Number(key.id) : null;
}

async function getAccountCounter(accountId: number) {
  const db = getTestDb();
  const [counter] = await db
    .select({ counter: usageCounters.counter })
    .from(usageCounters)
    .where(eq(usageCounters.accountId, BigInt(accountId)))
    .execute();
  return counter ? counter.counter : 0n;
}

describe("Bootstrap Integration Tests", () => {
  beforeEach(async () => {
    process.env.BOOTSTRAP_ACCOUNT_NAME = "Bootstrap Test Account";
    process.env.BOOTSTRAP_API_KEY_NAME = "Bootstrap Test Key";
  });

  afterEach(async () => {
    if (ORIGINAL_BOOTSTRAP_ACCOUNT_NAME === undefined) {
      delete process.env.BOOTSTRAP_ACCOUNT_NAME;
    } else {
      process.env.BOOTSTRAP_ACCOUNT_NAME = ORIGINAL_BOOTSTRAP_ACCOUNT_NAME;
    }
    if (ORIGINAL_BOOTSTRAP_API_KEY_NAME === undefined) {
      delete process.env.BOOTSTRAP_API_KEY_NAME;
    } else {
      process.env.BOOTSTRAP_API_KEY_NAME = ORIGINAL_BOOTSTRAP_API_KEY_NAME;
    }
  });

  it("seeds the predefined system-plan catalog idempotently on bootstrap", async () => {
    await bootstrap();

    const starter = await findSystemPlan("Starter", "account");
    expect(starter).not.toBeNull();
    expect(starter!.ownerAccountId).toBeNull();

    const pro = await findSystemPlan("Pro", "account");
    expect(pro).not.toBeNull();
    expect(pro!.ownerAccountId).toBeNull();

    const basic = await findSystemPlan("Basic", "user");
    expect(basic).not.toBeNull();
    expect(basic!.ownerAccountId).toBeNull();

    const premium = await findSystemPlan("Premium", "user");
    expect(premium).not.toBeNull();
    expect(premium!.ownerAccountId).toBeNull();

    const countAfterFirst = await countSystemPlans();
    expect(countAfterFirst).toBe(4);

    // Re-running bootstrap must not duplicate the catalog.
    await bootstrap();
    const countAfterSecond = await countSystemPlans();
    expect(countAfterSecond).toBe(4);
  });

  it("assigns the Starter system plan as the default account plan on bootstrap", async () => {
    await bootstrap();

    const account = await findAccount("Bootstrap Test Account");
    expect(account).not.toBeNull();

    const starter = await findSystemPlan("Starter", "account");
    expect(starter).not.toBeNull();

    const assignment = await findCurrentAccountAssignment(account!.id);
    expect(assignment).not.toBeNull();
    expect(BigInt(assignment!.planId)).toBe(starter!.id);
  });

  it("is idempotent: repeated bootstrap does not duplicate the account or assignment", async () => {
    await bootstrap();
    await bootstrap();

    const account = await findAccount("Bootstrap Test Account");
    expect(account).not.toBeNull();

    const assignmentRows = await findCurrentAccountAssignment(account!.id);
    expect(assignmentRows).not.toBeNull();

    const db = getTestDb();
    const accountRows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.name, "Bootstrap Test Account"))
      .execute();
    expect(accountRows.length).toBe(1);

    const openAssignments = await db
      .select({ id: planAssignments.id })
      .from(planAssignments)
      .where(
        and(
          eq(planAssignments.accountId, BigInt(account!.id)),
          isNull(planAssignments.userId),
          isNull(planAssignments.effectiveTo)
        )
      )
      .execute();
    expect(openAssignments.length).toBe(1);
  });

  it("allows usage to succeed after bootstrap and does not double-count repeated idempotency key", async () => {
    await bootstrap();

    const account = await findAccount("Bootstrap Test Account");
    expect(account).not.toBeNull();

    const apiKeyId = await findApiKey(account!.id);
    expect(apiKeyId).not.toBeNull();

    // First usage request should be accepted
    const result1 = await processUsageRequest(account!.id, {
      units: 5n,
      idempotencyKey: "bootstrap-usage-test",
    }, apiKeyId!);

    expect(result1.decision).toBe("accepted");
    expect(result1.accountRemaining.toString()).toBe("49995"); // 50000 (Starter) - 5

    const counterAfterFirst = await getAccountCounter(account!.id);
    expect(counterAfterFirst).toBe(5n);

    // Repeating the same idempotency key must not increment usage again
    const result2 = await processUsageRequest(account!.id, {
      units: 5n,
      idempotencyKey: "bootstrap-usage-test",
    }, apiKeyId!);

    expect(result2.decision).toBe("accepted");
    expect(result2.accountRemaining.toString()).toBe(result1.accountRemaining.toString());

    const counterAfterSecond = await getAccountCounter(account!.id);
    expect(counterAfterSecond).toBe(5n); // Still 5, not 10
  });
});
