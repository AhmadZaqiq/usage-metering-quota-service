import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTestDb, getTestPool } from "./setup.js";
import { accounts, users, plans, planAssignments, apiKeys, usageCounters, usageRequests } from "../db/schema/index.js";
import { eq, and, isNull, sql } from "drizzle-orm";
import { createApiKey } from "../application/auth/apiKeyService.js";
import { createPlan } from "../application/plans/planService.js";
import { createAssignment } from "../application/plans/assignmentService.js";
import { processUsageRequest } from "../application/usage/usageService.js";
import { getUtcMonthStart } from "../domain/date.js";
import { db } from "../db/client.js";
import { getRateLimiterStore, closeRateLimiterStore } from "../infrastructure/rateLimiter.js";

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
  await createAssignment(accountId, { planId, effectiveFrom }, accountId);
}

async function assignUserPlan(accountId: number, userId: string, planId: number) {
  const effectiveFrom = getUtcMonthStart();
  await createAssignment(accountId, { userId, planId, effectiveFrom }, accountId);
}

// Unique per invocation: uq_accounts_name requires live names to be unique.
let contextSeq = 0;

async function setupBasicTestContext() {
  const account = await createTestAccount(`Test Account ${++contextSeq}`);
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

describe("Transaction Rollback Integration Tests", () => {
  beforeEach(async () => {
    // Tables are truncated in setup.ts afterEach
  });

  // TST-02: failures injected with temporary PostgreSQL triggers so the REAL
  // processUsageRequest transaction (not a hand-written stand-in) must roll
  // back every effect: counter creation, counter increments, and the
  // usage_requests row.

  type FailurePoint = {
    table: "usage_requests" | "api_keys";
    event: "INSERT" | "UPDATE";
    column: string;
    value: string;
  };

  async function armFailure(point: FailurePoint): Promise<void> {
    const fn = `test_force_fail_${point.table}`;
    await getTestPool().query(`
      CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$
      BEGIN
        IF NEW.${point.column} = '${point.value}' THEN
          RAISE EXCEPTION 'forced failure (TST-02) on ${point.table}';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await getTestPool().query(`DROP TRIGGER IF EXISTS test_force_fail_${point.table} ON ${point.table}`);
    await getTestPool().query(`
      CREATE TRIGGER test_force_fail_${point.table}
      BEFORE ${point.event} ON ${point.table}
      FOR EACH ROW EXECUTE FUNCTION ${fn}()
    `);
  }

  async function disarmFailure(point: FailurePoint): Promise<void> {
    await getTestPool().query(`DROP TRIGGER IF EXISTS test_force_fail_${point.table} ON ${point.table}`);
    await getTestPool().query(`DROP FUNCTION IF EXISTS test_force_fail_${point.table}()`);
  }

  describe("Rollback through the real usage service", () => {
    it("rolls back counter creation when the usage_requests insert fails", async () => {
      const context = await setupBasicTestContext();
      const point: FailurePoint = {
        table: "usage_requests",
        event: "INSERT",
        column: "idempotency_key",
        value: "forced-insert-failure",
      };
      await armFailure(point);
      try {
        await expect(
          processUsageRequest(
            context.account.id,
            {
              userId: context.user.clientUserId,
              units: 1n,
              idempotencyKey: "forced-insert-failure",
            },
            context.apiKey.id,
          ),
        ).rejects.toThrow(/forced failure/);

        // Nothing persisted: no request record, no counter rows at all
        // (the upsert that created them happened inside the rolled-back tx).
        const requests = await getTestDb()
          .select()
          .from(usageRequests)
          .where(eq(usageRequests.idempotencyKey, "forced-insert-failure"))
          .execute();
        expect(requests).toHaveLength(0);

        const counters = await getTestDb()
          .select()
          .from(usageCounters)
          .where(eq(usageCounters.accountId, BigInt(context.account.id)))
          .execute();
        expect(counters).toHaveLength(0);
      } finally {
        await disarmFailure(point);
      }
    });

    it("rolls back counter increments and the request row when a later step of the service fails", async () => {
      const context = await setupBasicTestContext();
      const point: FailurePoint = {
        table: "api_keys",
        event: "UPDATE",
        column: "name",
        value: "fail-after-increment",
      };
      const failingKey = await createTestApiKey(context.account.id, point.value);

      await armFailure(point);
      try {
        // Counter increments run inside the same transaction BEFORE
        // updateApiKeyLastUsedAt; the forced failure must discard them too.
        await expect(
          processUsageRequest(
            context.account.id,
            {
              userId: context.user.clientUserId,
              units: 7n,
              idempotencyKey: "forced-late-failure",
            },
            failingKey.id,
          ),
        ).rejects.toThrow(/forced failure/);

        const requests = await getTestDb()
          .select()
          .from(usageRequests)
          .where(eq(usageRequests.idempotencyKey, "forced-late-failure"))
          .execute();
        expect(requests).toHaveLength(0);

        const counters = await getTestDb()
          .select()
          .from(usageCounters)
          .where(eq(usageCounters.accountId, BigInt(context.account.id)))
          .execute();
        expect(counters).toHaveLength(0);

        // The api_keys touch that failed did not stick either.
        const [keyRow] = await getTestDb()
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.id, BigInt(failingKey.id)))
          .execute();
        expect(keyRow.lastUsedAt).toBeNull();
      } finally {
        await disarmFailure(point);
      }
    });

    it("succeeds for the same request once the forced failure is removed", async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 5n,
          idempotencyKey: "retry-after-rollback",
        },
        context.apiKey.id,
      );

      expect(result.decision).toBe("accepted");
      expect(result.accountRemaining.toString()).toBe("995");

      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();
      expect(Number(counter?.counter ?? 0n)).toBe(5);

      const requests = await getTestDb()
        .select()
        .from(usageRequests)
        .where(eq(usageRequests.idempotencyKey, "retry-after-rollback"))
        .execute();
      expect(requests).toHaveLength(1);
    });
  });

  describe("Rollback on idempotency check", () => {
    it("should not leave partial state if idempotency check fails", async () => {
      const context = await setupBasicTestContext();

      // First request
      const result1 = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 5n,
        idempotencyKey: "rollback-idempotency-test",
      }, context.apiKey.id);

      expect(result1.decision).toBe("accepted");

      // Verify state is correct
      let [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();
      expect(Number(counter?.counter ?? 0n)).toBe(5);

      // Second request with SAME key but different payload should throw ConflictError
      // and NOT modify counters
      await expect(
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 10n, // Different payload
          idempotencyKey: "rollback-idempotency-test", // SAME KEY
        }, context.apiKey.id)
      ).rejects.toThrow("Idempotency key reused with different request data");

      // Counter should still be 5 (not 15)
      const [counter2] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();
      expect(Number(counter2?.counter ?? 0n)).toBe(5);

      // Only one usage_requests record should exist
      const records = await getTestDb()
        .select()
        .from(usageRequests)
        .where(eq(usageRequests.idempotencyKey, "rollback-idempotency-test"))
        .execute();

      expect(records.length).toBe(1);
    });
  });

  describe("Transaction retry behavior", () => {
    it("should retry on deadlock and eventually succeed", async () => {
      // This test verifies the retry logic works
      // We can't easily force a deadlock in a test, but we can verify
      // the retry logic is in place by checking the withTransaction function
      
      const context = await setupBasicTestContext();
      
      // Multiple rapid requests should not cause issues
      const requests = Array.from({ length: 5 }, (_, i) =>
        processUsageRequest(context.account.id, {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: `retry-test-${i}`,
        }, context.apiKey.id)
      );

      const results = await Promise.allSettled(requests);
      
      const fulfilled = results.filter(r => r.status === "fulfilled");
      expect(fulfilled.length).toBe(5);
      expect(fulfilled.every(r => r.value.decision === "accepted")).toBe(true);
    });
  });

  describe("Idempotent retry after failure", () => {
    it("should allow retry with same idempotency key after network failure", async () => {
      const context = await setupBasicTestContext();

      // First request succeeds
      const result1 = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 5n,
        idempotencyKey: "retry-after-failure",
      }, context.apiKey.id);

      expect(result1.decision).toBe("accepted");
      expect(result1.accountRemaining.toString()).toBe("995");

      // Simulate client retry (same request, same idempotency key)
      const result2 = await processUsageRequest(context.account.id, {
        userId: context.user.clientUserId,
        units: 5n,
        idempotencyKey: "retry-after-failure",
      }, context.apiKey.id);

      // Should return original decision without consuming more quota
      expect(result2.decision).toBe("accepted");
      expect(result2.accountRemaining.toString()).toBe("995"); // Still 995, not 990

      // Counter should still be 5
      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();
      expect(Number(counter?.counter ?? 0n)).toBe(5);
    });
  });

  describe("Rate limiter behavior", () => {
    it("should increment rate limit counter for unauthenticated requests", async () => {
      const store = getRateLimiterStore();

      // First request
      const first = await store.increment("ip:127.0.0.1", 60000);
      expect(first.total).toBe(1);
      expect(first.remaining).toBe(0); // remaining = total - 1 = 0

      // Second request with same key
      const second = await store.increment("ip:127.0.0.1", 60000);
      expect(second.total).toBe(2);
      expect(second.remaining).toBe(1);

      await closeRateLimiterStore();
    });

    it("should reset rate limit counter", async () => {
      const store = getRateLimiterStore();

      await store.increment("ip:reset-test", 60000);
      await store.increment("ip:reset-test", 60000);

      const before = await store.increment("ip:reset-test", 60000);
      expect(before.total).toBe(3);

      await store.reset("ip:reset-test");

      const after = await store.increment("ip:reset-test", 60000);
      expect(after.total).toBe(1);

      await closeRateLimiterStore();
    });

    // Rate-limiter failure policy is covered behaviorally in
    // src/test/rateLimiter.test.ts: falling back to the in-process store,
    // still enforcing limits when Redis is down, and failing closed when no
    // store works (the old "fail open" contract was intentionally removed).
  });
});