import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTestDb } from "./setup.js";
import { accounts, users, plans, planAssignments, apiKeys, usageCounters, usageRequests } from "../db/schema/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { createApiKey } from "../modules/auth/apiKeyService.js";
import { createUser } from "../modules/users/userService.js";
import { createPlan } from "../modules/plans/planService.js";
import { createAssignment } from "../modules/plans/assignmentService.js";
import { processUsageRequest } from "../modules/usage/usageService.js";
import { formatDateForDb, getUtcMonthStart } from "../utils/date.js";
import { upsertAndLockCounter } from "../modules/usage/counterRepository.js";

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

async function assignAccountPlan(accountId: number, planId: number) {
  const effectiveFrom = getUtcMonthStart();
  // Delete any existing account-level assignment for this account
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

async function assignUserPlan(accountId: number, userId: string, planId: number) {
  const effectiveFrom = getUtcMonthStart();
  await createAssignment(accountId, { userId, planId, effectiveFrom }, accountId);
}

async function setupBasicTestContext() {
  const account = await createTestAccount("Test Account");
  const apiKey = await createTestApiKey(account.id, "Test Key");

  const accountPlan = await createTestPlan(account.id, "Account Plan", "account", 1000n, 100n);
  const userPlan = await createTestPlan(account.id, "User Plan", "user", 100n, 10n);

  await assignAccountPlan(account.id, accountPlan.id);

  const user = await createTestUser(account.id, "user123");
  await assignUserPlan(account.id, user.clientUserId, userPlan.id);

  return {
    account,
    user,
    accountPlan,
    userPlan,
    apiKey,
  };
}

function runConcurrent<T>(fn: () => Promise<T>, count: number): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, () => fn()));
}

describe("Concurrency Integration Tests", () => {
  beforeEach(async () => {
    // Tables are truncated in setup.ts afterEach
  });

  describe("A. Concurrent requests competing for remaining account quota", () => {
    it("should not exceed account quota when multiple concurrent requests compete for remaining units", async () => {
      const context = await setupBasicTestContext();
      const { account, user, apiKey } = context;

      // Set up: account has 1000 allowance, use 995, leaving 5
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(account.id), null, periodStart);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 995n })
        .where(eq(usageCounters.accountId, BigInt(account.id)))
        .execute();

      // Fire 10 concurrent requests, each requesting 1 unit (total 10, but only 5 available)
      const requests = Array.from({ length: 10 }, (_, i) =>
        processUsageRequest(account.id, {
          userId: user.clientUserId,
          units: 1n,
          idempotencyKey: `concurrent-account-${i}`,
        }, apiKey.id)
      );

      const results = await Promise.allSettled(requests);

      const accepted = results.filter(r => r.status === "fulfilled" && r.value.decision === "accepted").length;
      const rejected = results.filter(r => r.status === "fulfilled" && r.value.decision === "rejected").length;
      const errors = results.filter(r => r.status === "rejected").length;

      // Should accept exactly 5 (remaining quota) and reject 5
      expect(accepted).toBe(5);
      expect(rejected).toBe(5);
      expect(errors).toBe(0);

      // Verify final counter state
      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(account.id)))
        .execute();

      expect(Number(counter?.counter ?? 0n)).toBe(1000); // 995 + 5 accepted = 1000 (exactly at limit)
    }, 30000);

    it("should not allow counter to go negative", async () => {
      const context = await setupBasicTestContext();

      // Pre-consume all 1000 units
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), null, periodStart);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 1000n })
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 1n,
        idempotencyKey: "negative-test-1",
      }, context.apiKey.id);

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("account_quota_exceeded");

      // Counter should still be 1000
      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      expect(Number(counter?.counter ?? 0n)).toBe(1000);
    });
  });

  describe("B. Concurrent requests competing for user quota", () => {
    it("should not exceed user quota when multiple concurrent requests compete for remaining units", async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 95 out of 100 user units, leaving 5
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), BigInt(context.user.id), periodStart);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 95n })
        .where(
          and(
            eq(usageCounters.accountId, BigInt(context.account.id)),
            eq(usageCounters.userId, BigInt(context.user.id))
          )
        )
        .execute();

      // Fire 10 concurrent requests, each requesting 1 unit (total 10, but only 5 available)
      const requests = Array.from({ length: 10 }, (_, i) =>
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: `concurrent-user-${i}`,
        }, context.apiKey.id)
      );

      const results = await Promise.allSettled(requests);

      const accepted = results.filter(r => r.status === "fulfilled" && r.value.decision === "accepted").length;
      const rejected = results.filter(r => r.status === "fulfilled" && r.value.decision === "rejected").length;
      const errors = results.filter(r => r.status === "rejected").length;

      expect(accepted).toBe(5);
      expect(rejected).toBe(5);
      expect(errors).toBe(0);

      // Verify final user counter state
      const [userCounter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.accountId, BigInt(context.account.id)),
            eq(usageCounters.userId, BigInt(context.user.id))
          )
        )
        .execute();

      expect(Number(userCounter?.counter ?? 0n)).toBe(100); // 95 + 5 accepted = 100 (exactly at user limit)
    }, 30000);

    it("should enforce both account and user quota simultaneously", async () => {
      const context = await setupBasicTestContext();

      // Set account to 998/1000, user to 98/100
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), null, periodStart);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 998n })
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), BigInt(context.user.id), periodStart);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 98n })
        .where(
          and(
            eq(usageCounters.accountId, BigInt(context.account.id)),
            eq(usageCounters.userId, BigInt(context.user.id))
          )
        )
        .execute();

      // Request 3 units - should be rejected due to user limit (only 2 remaining)
      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 3n,
        idempotencyKey: "both-limits-test",
      }, context.apiKey.id);

      expect(result.decision).toBe("rejected");
      // Account has 2 remaining, user has 2 remaining, request 3 - user quota exceeded first
      // But account is checked first, so account_quota_exceeded is returned
      // This is the current behavior - account quota checked first
      expect(result.rejectionReason).toBe("account_quota_exceeded");
    });
  });

  describe("C. Concurrent duplicate idempotency keys", () => {
    it("should process identical concurrent requests idempotently", async () => {
      const context = await setupBasicTestContext();

      const sameKey = "same-idempotency-key";
      const requestData = {
        userId: context.user.clientUserId,
        units: 5n,
        idempotencyKey: sameKey,
      };

      // Fire 10 concurrent requests with identical key and payload
      const requests = Array.from({ length: 10 }, () =>
        processUsageRequest(context.account.id, requestData, context.apiKey.id)
      );

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter(r => r.status === "fulfilled");
      const errors = results.filter(r => r.status === "rejected");

      expect(errors.length).toBe(0);
      expect(fulfilled.length).toBe(10);

      // All should return the same decision
      const decisions = fulfilled.map(r => r.value.decision);
      expect(new Set(decisions).size).toBe(1);
      expect(fulfilled[0].value.decision).toBe("accepted");

      // Only one usage_requests record should exist
      const [record] = await getTestDb()
        .select()
        .from(usageRequests)
        .where(eq(usageRequests.idempotencyKey, sameKey))
        .execute();

      expect(record).toBeDefined();
      expect(record.decision).toBe("accepted");

      // Only 5 units should be consumed (not 50)
      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      expect(Number(counter?.counter ?? 0n)).toBe(5);
    }, 30000);

    it("should reject conflicting payload with same idempotency key", async () => {
      const context = await setupBasicTestContext();

      const sameKey = "conflicting-key";

      // First request with 5 units
      await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 5n,
        idempotencyKey: sameKey,
      }, context.apiKey.id);

      // Second request with same key but different units - should throw ConflictError
      await expect(
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 10n, // Different payload
          idempotencyKey: sameKey,
        }, context.apiKey.id)
      ).rejects.toThrow("Idempotency key reused with different request data");
    });

    it("should handle concurrent conflicting payloads", async () => {
      const context = await setupBasicTestContext();

      const sameKey = "concurrent-conflict";

      // Fire concurrent requests with same key but different payloads
      const requests = [
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 5n,
          idempotencyKey: sameKey,
        }, context.apiKey.id),
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 10n,
          idempotencyKey: sameKey,
        }, context.apiKey.id),
      ];

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter(r => r.status === "fulfilled");
      const rejected = results.filter(r => r.status === "rejected");

      // One should succeed, one should fail with ConflictError
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].reason?.message).toContain("Idempotency key reused with different request data");
    }, 30000);
  });

  describe("D. Independent requests", () => {
    it("should handle distinct idempotency keys independently", async () => {
      const context = await setupBasicTestContext();

      const requests = Array.from({ length: 10 }, (_, i) =>
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: `independent-${i}`,
        }, context.apiKey.id)
      );

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter(r => r.status === "fulfilled");
      expect(fulfilled.length).toBe(10);
      expect(fulfilled.every(r => r.value.decision === "accepted")).toBe(true);

      // All 10 units should be consumed
      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      expect(Number(counter?.counter ?? 0n)).toBe(10);
    });

    it("should isolate unrelated accounts", async () => {
      const context1 = await setupBasicTestContext();
      const context2 = await setupBasicTestContext();

      // Pre-consume all quota for account 1
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context1.account.id), null, periodStart);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 1000n })
        .where(eq(usageCounters.accountId, BigInt(context1.account.id)))
        .execute();

      // Account 1 should be rejected
      const result1 = await processUsageRequest(context1.account.id, {
        userId: context1.user.clientUserId,
        units: 1n,
        idempotencyKey: "account1-request",
      }, context1.apiKey.id);

      expect(result1.decision).toBe("rejected");

      // Account 2 should still work (has its own 1000 quota)
      const result2 = await processUsageRequest(context2.account.id, {
        userId: context2.user.clientUserId,
        units: 1n,
        idempotencyKey: "account2-request",
      }, context2.apiKey.id);

      expect(result2.decision).toBe("accepted");
    });
  });

  describe("E. Concurrent assignment creation", () => {
    it("should not create overlapping account-level assignments concurrently", async () => {
      const context = await setupBasicTestContext();
      const { account, apiKey } = context;

      // Create an account plan
      const plan = await createPlan(
        { name: "Concurrent Plan", type: "account", monthlyAllowance: 1000n, maxUnitsPerRequest: 100n },
        account.id
      );

      // Delete any existing account-level assignment so we start clean
      const db = getTestDb();
      await db
        .delete(planAssignments)
        .where(
          and(
            eq(planAssignments.accountId, BigInt(account.id)),
            isNull(planAssignments.userId)
          )
        )
        .execute();

      // Fire two concurrent requests to assign the same plan at account level
      const requests = [
        createAssignment(account.id, { planId: plan.id, effectiveFrom: getUtcMonthStart() }, account.id),
        createAssignment(account.id, { planId: plan.id, effectiveFrom: getUtcMonthStart() }, account.id),
      ];

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter(r => r.status === "fulfilled");
      const rejected = results.filter(r => r.status === "rejected");

      // Exactly one should succeed, one should fail with ConflictError
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].reason?.message).toContain("Overlapping assignment exists");

      // Verify only one assignment exists in the database
      const assignments = await db
        .select()
        .from(planAssignments)
        .where(
          and(
            eq(planAssignments.accountId, BigInt(account.id)),
            isNull(planAssignments.userId),
            isNull(planAssignments.effectiveTo)
          )
        )
        .execute();

      expect(assignments.length).toBe(1);
    }, 30000);
  });

  describe("F. Concurrent user creation", () => {
    it("should not create duplicate users with same (accountId, clientUserId) concurrently", async () => {
      const context = await setupBasicTestContext();
      const { account } = context;

      // Fire two concurrent requests to create the same user
      const requests = [
        createUser(account.id, "duplicate-user"),
        createUser(account.id, "duplicate-user"),
      ];

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter(r => r.status === "fulfilled");
      const rejected = results.filter(r => r.status === "rejected");

      // Exactly one should succeed, one should fail with ValidationError
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].reason?.message).toContain("User with this identifier already exists");

      // Verify only one user exists in the database
      const dbUsers = await getTestDb()
        .select()
        .from(users)
        .where(
          and(
            eq(users.accountId, BigInt(account.id)),
            eq(users.clientUserId, "duplicate-user"),
            isNull(users.deletedAt)
          )
        )
        .execute();

      expect(dbUsers.length).toBe(1);
    }, 30000);
  });
});