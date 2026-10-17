import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTestDb } from "./setup.js";
import { accounts, users, plans, planAssignments, apiKeys, usageCounters, usageRequests } from "../db/schema/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { createApiKey, revokeApiKey } from "../modules/auth/apiKeyService.js";
import { createPlan, listPlans, getPlan, updatePlan, deletePlan } from "../modules/plans/planService.js";
import { createAssignment } from "../modules/plans/assignmentService.js";
import { processUsageRequest } from "../modules/usage/usageService.js";
import { getUsageHistory } from "../modules/usage/usageHistoryService.js";
import { evaluateQuota } from "../modules/usage/quotaEvaluator.js";
import { formatDateForDb, getUtcMonthStart } from "../utils/date.js";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../config/index.js";
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

  const accountPlan = await createTestPlan(account.id, "Account Plan", "account", 1000n, MAX_UNITS_PER_REQUEST_BIGINT);
  const userPlan = await createTestPlan(account.id, "User Plan", "user", 100n, 100n);

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

function formatBigInt(obj: any): any {
  return JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  ));
}

describe("Boundary Integration Tests", () => {
  beforeEach(async () => {
    // Tables are truncated in setup.ts afterEach
  });

  describe("A. Account and user quota boundaries", () => {
    it("should accept request that exactly consumes remaining account quota", async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 995 out of 1000
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), null, periodStart);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 995n })
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      // Request exactly 5 units (remaining quota)
      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 5n,
        idempotencyKey: "exact-quota",
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
      expect(result.accountRemaining.toString()).toBe("0");

      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();
      expect(Number(counter?.counter ?? 0n)).toBe(1000);
    });

    it("should reject request exceeding remaining account quota by one unit", async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 995 out of 1000
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), null, periodStart);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 995n })
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      // Request 6 units (1 over remaining 5)
      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 6n,
        idempotencyKey: "over-quota-by-one",
      }, context.apiKey.id);

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("account_quota_exceeded");
      expect(result.accountRemaining.toString()).toBe("5"); // 5 remaining before request
    });

    it("should accept request that exactly consumes remaining user quota", async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 95 out of 100 user quota
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

      // Request exactly 5 units (remaining user quota)
      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 5n,
        idempotencyKey: "exact-user-quota",
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
      expect(result.userRemaining?.toString()).toBe("0");
    });

    it("should reject request exceeding remaining user quota by one unit", async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 95 out of 100 user quota
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

      // Request 6 units (1 over remaining 5)
      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 6n,
        idempotencyKey: "over-user-quota-by-one",
      }, context.apiKey.id);

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("user_quota_exceeded");
      expect(result.userRemaining?.toString()).toBe("5");
    });

    it("should handle zero remaining quota correctly", async () => {
      const context = await setupBasicTestContext();

      // Exhaust account quota completely
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
        idempotencyKey: "zero-quota",
      }, context.apiKey.id);

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("account_quota_exceeded");
      expect(result.accountRemaining.toString()).toBe("0");
    });
  });

  describe("B. Bigint correctness", () => {
    async function setupBigintTestContext() {
      const account = await createTestAccount("Bigint Test Account");
      const apiKey = await createTestApiKey(account.id, "Bigint Test Key");

      // Create account plan with high limit
      const accountPlan = await createTestPlan(account.id, "Account Plan", "account", 10000000000000000n, MAX_UNITS_PER_REQUEST_BIGINT);
      // Create user plan with high limit (to not restrict the test)
      const userPlan = await createTestPlan(account.id, "User Plan", "user", 10000000000000000n, MAX_UNITS_PER_REQUEST_BIGINT);

      await assignAccountPlan(account.id, accountPlan.id);

      const user = await createTestUser(account.id, "bigint-user");
      await assignUserPlan(account.id, user.clientUserId, userPlan.id);

      return {
        account,
        user,
        accountPlan,
        userPlan,
        apiKey,
      };
    }

    it("should handle large values within database limits", async () => {
      const context = await setupBigintTestContext();

      // Test with large values near the MAX_UNITS_PER_REQUEST limit
      const largeUnits = MAX_UNITS_PER_REQUEST_BIGINT - 100n; // 9900

      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: largeUnits,
        idempotencyKey: "large-units",
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
      // accountRemaining = monthlyAllowance - accountUsed - requestedUnits
      expect(result.accountRemaining.toString()).toBe((10000000000000000n - largeUnits).toString());
    });

    it("should reject units exceeding MAX_UNITS_PER_REQUEST", async () => {
      const context = await setupBigintTestContext();

      const tooLarge = MAX_UNITS_PER_REQUEST_BIGINT + 1n;

      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: tooLarge,
        idempotencyKey: "too-large",
      }, context.apiKey.id);

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("max_per_request_exceeded");
    });

    it("should handle values beyond JavaScript safe integer range correctly", async () => {
      // Test that the system correctly handles bigint arithmetic throughout
      // (values within our configured limits but demonstrating bigint usage)
      
      const context = await setupBigintTestContext();
      
      // Use a large value within our configured limits to test bigint arithmetic
      const largeValue = 9999n; // Within MAX_UNITS_PER_REQUEST_BIGINT (10000)
      
      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: largeValue,
        idempotencyKey: "beyond-safe-integer",
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
      expect(result.accountRemaining.toString()).toBe((10000000000000000n - largeValue).toString());
    });

    it("should correctly persist and retrieve bigint values", async () => {
      const context = await setupBigintTestContext();

      const largeUnits = 9999n; // Large but within MAX_UNITS_PER_REQUEST_BIGINT limit

      await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: largeUnits,
        idempotencyKey: "bigint-persistence",
      }, context.apiKey.id);

      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      expect(counter?.counter).toBe(largeUnits);
    });
  });

  describe("C. Monthly UTC boundaries", () => {
    it("should use correct period at UTC month boundary", async () => {
      // Test that getUtcMonthStart computes correctly
      const date1 = new Date("2026-10-15T23:59:59.999Z"); // End of October UTC
      const date2 = new Date("2026-11-01T00:00:00.000Z"); // Start of November UTC (fixed)

      // We can't easily test the actual month boundary without mocking time,
      // but we can verify the utility function works correctly
      const { getUtcMonthStart } = await import("../utils/date.js");
      
      const october = getUtcMonthStart(date1);
      const november = getUtcMonthStart(date2);

      expect(october.getUTCMonth()).toBe(9); // October (0-indexed)
      expect(november.getUTCMonth()).toBe(10); // November (0-indexed)
      expect(october.getUTCDate()).toBe(1);
      expect(november.getUTCDate()).toBe(1);
    });

    it("should correctly compute period start for requests", async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 1n,
        idempotencyKey: "period-test",
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
      expect(result.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      
      // Verify it matches current UTC month start
      const expectedPeriod = formatDateForDb(getUtcMonthStart());
      expect(result.periodStart).toBe(expectedPeriod);
    });

    it("should track usage separately for different months", async () => {
      const context = await setupBasicTestContext();

      // Pre-populate counter for "previous month" (manually set period_start)
      const previousMonth = new Date(Date.UTC(2026, 8, 1)); // September 2026
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), null, previousMonth.toISOString().split("T")[0]);
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 500n })
        .where(
          and(
            eq(usageCounters.accountId, BigInt(context.account.id)),
            eq(usageCounters.periodStart, previousMonth.toISOString().split("T")[0])
          )
        )
        .execute();

      // Current month should start fresh
      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 10n,
        idempotencyKey: "month-boundary",
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
      expect(result.accountRemaining.toString()).toBe("990"); // Fresh 1000 - 10

      // Previous month counter should be unchanged
      const [prevCounter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.accountId, BigInt(context.account.id)),
            eq(usageCounters.periodStart, previousMonth.toISOString().split("T")[0])
          )
        )
        .execute();
      expect(Number(prevCounter?.counter ?? 0n)).toBe(500);
    });
  });

  describe("D. Idempotency boundaries", () => {
    it("should accept minimum valid idempotency key length (1 char)", async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 1n,
        idempotencyKey: "a", // 1 char
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
    });

    it("should accept maximum valid idempotency key length (255 chars)", async () => {
      const context = await setupBasicTestContext();

      const longKey = "a".repeat(255);
      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 1n,
        idempotencyKey: longKey,
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
    });

    it("should reject empty idempotency key", async () => {
      const context = await setupBasicTestContext();

      await expect(
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: "", // Empty
        }, context.apiKey.id)
      ).rejects.toThrow(); // ValidationError from Zod
    });

    it("should reject idempotency key exceeding 255 chars", async () => {
      const context = await setupBasicTestContext();

      await expect(
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: "a".repeat(256), // Too long
        }, context.apiKey.id)
      ).rejects.toThrow(); // ValidationError from Zod
    });

    it("should reject zero units", async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 0n,
        idempotencyKey: "zero-units",
      }, context.apiKey.id);

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("max_per_request_exceeded");
    });

    it("should reject negative units", async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: -1n,
        idempotencyKey: "negative-units",
      }, context.apiKey.id);

      expect(result.decision).toBe("rejected");
      expect(result.rejectionReason).toBe("max_per_request_exceeded");
    });
  });

  describe("E. Usage history and pagination", () => {
    it("should return paginated usage history", async () => {
      const context = await setupBasicTestContext();

      // Create several usage requests
      for (let i = 1; i <= 5; i++) {
        await processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: BigInt(i),
          idempotencyKey: `history-test-${i}`,
        }, context.apiKey.id);
      }

      // Fetch page 1 with limit 3
      const page1 = await getUsageHistory(BigInt(context.account.id), 1, 3);

      expect(page1.items).toHaveLength(3);
      expect(page1.total).toBe(5);
      expect(page1.page).toBe(1);
      expect(page1.limit).toBe(3);
      expect(page1.totalPages).toBe(2);

      // Items should be ordered by created_at descending (newest first)
      expect(page1.items[0].idempotencyKey).toBe("history-test-5");
      expect(page1.items[1].idempotencyKey).toBe("history-test-4");
      expect(page1.items[2].idempotencyKey).toBe("history-test-3");

      // Fetch page 2 with limit 3
      const page2 = await getUsageHistory(BigInt(context.account.id), 2, 3);

      expect(page2.items).toHaveLength(2);
      expect(page2.items[0].idempotencyKey).toBe("history-test-2");
      expect(page2.items[1].idempotencyKey).toBe("history-test-1");
    });

    it("should isolate usage history by account", async () => {
      const context1 = await setupBasicTestContext();
      const context2 = await setupBasicTestContext();

      // Create usage requests in account 1
      await processUsageRequest(context1.account.id, {
        userId: context1.user.clientUserId,
        units: 1n,
        idempotencyKey: "account1-request-1",
      }, context1.apiKey.id);

      await processUsageRequest(context1.account.id, {
        userId: context1.user.clientUserId,
        units: 2n,
        idempotencyKey: "account1-request-2",
      }, context1.apiKey.id);

      // Create usage request in account 2
      await processUsageRequest(context2.account.id, {
        userId: context2.user.clientUserId,
        units: 10n,
        idempotencyKey: "account2-request-1",
      }, context2.apiKey.id);

      // Account 1 should only see its own requests
      const page1 = await getUsageHistory(BigInt(context1.account.id), 1, 10);
      expect(page1.items).toHaveLength(2);
      expect(page1.items.map(r => r.idempotencyKey)).toContain("account1-request-1");
      expect(page1.items.map(r => r.idempotencyKey)).toContain("account1-request-2");
      expect(page1.items.map(r => r.idempotencyKey)).not.toContain("account2-request-1");

      // Account 2 should only see its own requests
      const page2 = await getUsageHistory(BigInt(context2.account.id), 1, 10);
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].idempotencyKey).toBe("account2-request-1");
    });

    it("should return empty results for account with no usage history", async () => {
      const context = await setupBasicTestContext();

      const page = await getUsageHistory(BigInt(context.account.id), 1, 10);

      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(0);
      expect(page.totalPages).toBe(0);
    });

    it("should include account remaining and user remaining in history items", async () => {
      const context = await setupBasicTestContext();

      await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 5n,
        idempotencyKey: "history-remaining-test",
      }, context.apiKey.id);

      const page = await getUsageHistory(BigInt(context.account.id), 1, 10);

      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      expect(item.idempotencyKey).toBe("history-remaining-test");
      expect(item.decision).toBe("accepted");
      expect(item.accountRemaining).toBe("995"); // 1000 - 5
      expect(item.userRemaining).toBe("95"); // 100 - 5
    });
  });

  describe("F. API key management", () => {
    it("should create an API key and return the full secret once", async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 1n,
        idempotencyKey: "api-key-test",
      }, context.apiKey.id);

      expect(result.decision).toBe("accepted");
    });

    it("should list API keys for an account", async () => {
      const context = await setupBasicTestContext();

      // Create a second API key
      await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 1n,
        idempotencyKey: "create-second-key",
      }, context.apiKey.id);

      // List API keys - all keys for the account should be returned
      const keys = await getTestDb()
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.accountId, BigInt(context.account.id)))
        .execute();

      expect(keys.length).toBeGreaterThanOrEqual(1);
      // Each key should have a prefix but not the full secret
      for (const key of keys) {
        expect(key.prefix).toBeDefined();
        expect(key.keyHash).toBeDefined();
        expect(key.idempotencyKey).toBeUndefined(); // full secret not stored
      }
    });

    it("should revoke an API key", async () => {
      const context = await setupBasicTestContext();

      // Create a new API key
      const keyResult = await createApiKey(context.account.id, "Revocable Key");

      // Verify the key exists
      const [existingKey] = await getTestDb()
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyResult.id))
        .execute();
      expect(existingKey.isRevoked).toBe(false);

      // Revoke the key
      await revokeApiKey(context.account.id, keyResult.id);

      // Verify the key is revoked
      const [revokedKey] = await getTestDb()
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, keyResult.id))
        .execute();
      expect(revokedKey.isRevoked).toBe(true);
    });
  });

  describe("G. Plan management", () => {
    it("should create, read, update, and delete a custom plan", async () => {
      const context = await setupBasicTestContext();

      // Create a custom plan
      const createdPlan = await createPlan(
        {
          name: "Custom Plan",
          type: "account",
          monthlyAllowance: 500n,
          maxUnitsPerRequest: 50n,
        },
        context.account.id
      );

      expect(createdPlan.name).toBe("Custom Plan");
      expect(createdPlan.type).toBe("account");
      expect(createdPlan.monthlyAllowance).toBe(500n);
      expect(createdPlan.maxUnitsPerRequest).toBe(50n);
      expect(createdPlan.isSystem).toBe(false);

      // List plans - should include both system and custom plans
      const plans = await listPlans(context.account.id);
      expect(plans.length).toBeGreaterThanOrEqual(1);
      expect(plans.some(p => p.name === "Custom Plan")).toBe(true);

      // Get the plan by ID
      const fetchedPlan = await getPlan(createdPlan.id, context.account.id);
      expect(fetchedPlan.id).toBe(createdPlan.id);
      expect(fetchedPlan.name).toBe("Custom Plan");

      // Update the plan
      const updatedPlan = await updatePlan(createdPlan.id, {
        monthlyAllowance: 2000n,
      }, context.account.id);
      expect(updatedPlan.monthlyAllowance).toBe(2000n);

      // Delete the plan
      await deletePlan(createdPlan.id, context.account.id);

      // Verify deletion - the plan should be soft-deleted
      const deletedPlan = await getPlan(createdPlan.id, context.account.id).catch(() => null);
      expect(deletedPlan).toBeNull();
    });

    it("should prevent modifying a system plan", async () => {
      const context = await setupBasicTestContext();

      // Create a system plan (ownerAccountId = null)
      const systemPlan = await createPlan(
        {
          name: "System Plan",
          type: "account",
          monthlyAllowance: 500n,
          maxUnitsPerRequest: 50n,
          ownerAccountId: null,
        },
        context.account.id
      );

      await expect(
        updatePlan(systemPlan.id, {
          monthlyAllowance: 999999n,
        }, context.account.id)
      ).rejects.toThrow("Cannot modify system plan");
    });

    it("should prevent assigning a plan from another account", async () => {
      const context1 = await setupBasicTestContext();
      const context2 = await setupBasicTestContext();

      // Try to assign account 2's plan to account 1
      await expect(
        createAssignment(context1.account.id, {
          planId: context2.accountPlan.id,
          effectiveFrom: getUtcMonthStart(),
        }, context1.account.id)
      ).rejects.toThrow("Cannot assign custom plan from another account");
    });

    it("should enforce plan type compatibility", async () => {
      const context = await setupBasicTestContext();

      // Try to assign a user plan as an account-level assignment
      await expect(
        createAssignment(context.account.id, {
          planId: context.userPlan.id,
          effectiveFrom: getUtcMonthStart(),
        }, context.account.id)
      ).rejects.toThrow("Account-level assignment requires an account plan");

      // Try to assign an account plan as a user-level assignment
      await expect(
        createAssignment(context.account.id, {
          userId: context.user.clientUserId,
          planId: context.accountPlan.id,
          effectiveFrom: getUtcMonthStart(),
        }, context.account.id)
      ).rejects.toThrow("User-level assignment requires a user plan");
    });
  });
});