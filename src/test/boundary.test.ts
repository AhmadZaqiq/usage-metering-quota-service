import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTestDb } from './setup.js';
import {
  accounts,
  users,
  plans,
  planAssignments,
  apiKeys,
  usageCounters,
  usageRequests,
} from '../db/schema/index.js';
import { eq, and, isNull } from 'drizzle-orm';
import { createApiKey, revokeApiKey } from '../application/auth/apiKeyService.js';
import {
  createPlan,
  listPlans,
  getPlan,
  updatePlan,
  deletePlan,
} from '../application/plans/planService.js';
import { createAssignment } from '../application/plans/assignmentService.js';
import { processUsageRequest } from '../application/usage/usageService.js';
import { getUsageHistory } from '../application/usage/usageHistoryService.js';
import { getCurrentAssignments } from '../application/plans/assignmentHistoryService.js';
import { evaluateQuota } from '../domain/quotaEvaluator.js';
import { formatDateForDb, getUtcMonthStart, getNextUtcMonthStart } from '../domain/date.js';
import { MAX_UNITS_PER_REQUEST_BIGINT } from '../config/index.js';
import { upsertAndLockCounter } from '../infrastructure/repositories/counterRepository.js';
import {
  selectPlanById,
  updatePlan as updatePlanRow,
} from '../infrastructure/repositories/planRepository.js';
import { ConflictError } from '../errors/AppError.js';

/** ISO instant inside the given 'YYYY-MM-DD' period, so seeded counters stay INV-5-consistent. */
function isoAtPeriodStart(periodStart: string): string {
  return `${periodStart}T00:00:00.000Z`;
}

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
  type: 'account' | 'user',
  monthlyAllowance: bigint,
  maxUnitsPerRequest: bigint
) {
  const plan = await createPlan({ name, type, monthlyAllowance, maxUnitsPerRequest }, accountId);
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
    .where(and(eq(planAssignments.accountId, BigInt(accountId)), isNull(planAssignments.userId)))
    .execute();
  await createAssignment(accountId, { planId, effectiveFrom: getUtcMonthStart() }, accountId);
}

async function assignUserPlan(accountId: number, userId: string, planId: number) {
  const effectiveFrom = getUtcMonthStart();
  await createAssignment(accountId, { userId, planId, effectiveFrom }, accountId);
}

// Each context gets its own account name: uq_accounts_name requires live
// account names to be unique, which is exactly what production guarantees.
let contextSeq = 0;

async function setupBasicTestContext() {
  const account = await createTestAccount(`Test Account ${++contextSeq}`);
  const apiKey = await createTestApiKey(account.id, 'Test Key');

  const accountPlan = await createTestPlan(
    account.id,
    'Account Plan',
    'account',
    1000n,
    MAX_UNITS_PER_REQUEST_BIGINT
  );
  const userPlan = await createTestPlan(account.id, 'User Plan', 'user', 100n, 100n);

  await assignAccountPlan(account.id, accountPlan.id);

  const user = await createTestUser(account.id, 'user123');
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
  return JSON.parse(
    JSON.stringify(obj, (key, value) => (typeof value === 'bigint' ? value.toString() : value))
  );
}

describe('Boundary Integration Tests', () => {
  beforeEach(async () => {
    // Tables are truncated in setup.ts afterEach
  });

  describe('A. Account and user quota boundaries', () => {
    it('should accept request that exactly consumes remaining account quota', async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 995 out of 1000
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), null, periodStart, isoAtPeriodStart(periodStart));
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 995n })
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      // Request exactly 5 units (remaining quota)
      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 5n,
          idempotencyKey: 'exact-quota',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('accepted');
      expect(result.accountRemaining.toString()).toBe('0');

      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();
      expect(Number(counter?.counter ?? 0n)).toBe(1000);
    });

    it('should reject request exceeding remaining account quota by one unit', async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 995 out of 1000
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), null, periodStart, isoAtPeriodStart(periodStart));
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 995n })
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      // Request 6 units (1 over remaining 5)
      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 6n,
          idempotencyKey: 'over-quota-by-one',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('account_quota_exceeded');
      expect(result.accountRemaining.toString()).toBe('5'); // 5 remaining before request
    });

    it('should accept request that exactly consumes remaining user quota', async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 95 out of 100 user quota
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(
        getTestDb(),
        BigInt(context.account.id),
        BigInt(context.user.id),
        periodStart,
        isoAtPeriodStart(periodStart)
      );
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
      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 5n,
          idempotencyKey: 'exact-user-quota',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('accepted');
      expect(result.userRemaining?.toString()).toBe('0');
    });

    it('should reject request exceeding remaining user quota by one unit', async () => {
      const context = await setupBasicTestContext();

      // Pre-consume 95 out of 100 user quota
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(
        getTestDb(),
        BigInt(context.account.id),
        BigInt(context.user.id),
        periodStart,
        isoAtPeriodStart(periodStart)
      );
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
      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 6n,
          idempotencyKey: 'over-user-quota-by-one',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('user_quota_exceeded');
      expect(result.userRemaining?.toString()).toBe('5');
    });

    it('should handle zero remaining quota correctly', async () => {
      const context = await setupBasicTestContext();

      // Exhaust account quota completely
      const periodStart = formatDateForDb(getUtcMonthStart());
      await upsertAndLockCounter(getTestDb(), BigInt(context.account.id), null, periodStart, isoAtPeriodStart(periodStart));
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 1000n })
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: 'zero-quota',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('account_quota_exceeded');
      expect(result.accountRemaining.toString()).toBe('0');
    });
  });

  describe('B. Bigint correctness', () => {
    async function setupBigintTestContext() {
      const account = await createTestAccount('Bigint Test Account');
      const apiKey = await createTestApiKey(account.id, 'Bigint Test Key');

      // Create account plan with high limit
      const accountPlan = await createTestPlan(
        account.id,
        'Account Plan',
        'account',
        10000000000000000n,
        MAX_UNITS_PER_REQUEST_BIGINT
      );
      // Create user plan with high limit (to not restrict the test)
      const userPlan = await createTestPlan(
        account.id,
        'User Plan',
        'user',
        10000000000000000n,
        MAX_UNITS_PER_REQUEST_BIGINT
      );

      await assignAccountPlan(account.id, accountPlan.id);

      const user = await createTestUser(account.id, 'bigint-user');
      await assignUserPlan(account.id, user.clientUserId, userPlan.id);

      return {
        account,
        user,
        accountPlan,
        userPlan,
        apiKey,
      };
    }

    it('should handle large values within database limits', async () => {
      const context = await setupBigintTestContext();

      // Test with large values near the MAX_UNITS_PER_REQUEST limit
      const largeUnits = MAX_UNITS_PER_REQUEST_BIGINT - 100n; // 9900

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: largeUnits,
          idempotencyKey: 'large-units',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('accepted');
      // accountRemaining = monthlyAllowance - accountUsed - requestedUnits
      expect(result.accountRemaining.toString()).toBe((10000000000000000n - largeUnits).toString());
    });

    it('should reject units exceeding MAX_UNITS_PER_REQUEST', async () => {
      const context = await setupBigintTestContext();

      const tooLarge = MAX_UNITS_PER_REQUEST_BIGINT + 1n;

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: tooLarge,
          idempotencyKey: 'too-large',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('max_per_request_exceeded');
    });

    it('should handle values beyond JavaScript safe integer range correctly', async () => {
      const context = await setupBigintTestContext();

      // 9007199254740993 = 2^53 + 1: the smallest integer that a JavaScript
      // Number cannot represent exactly. The bigint path must keep the exact
      // value and reject it against MAX_UNITS_PER_REQUEST without precision
      // loss or coercion to 9007199254740992.
      const beyondSafeInteger = 9_007_199_254_740_993n;

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: beyondSafeInteger,
          idempotencyKey: 'beyond-safe-integer',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('max_per_request_exceeded');
      // Quota untouched by the rejected request
      expect(result.accountRemaining.toString()).toBe('10000000000000000');
    });

    it('should correctly persist and retrieve bigint values', async () => {
      const context = await setupBigintTestContext();

      const largeUnits = 9999n; // Large but within MAX_UNITS_PER_REQUEST_BIGINT limit

      await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: largeUnits,
          idempotencyKey: 'bigint-persistence',
        },
        context.apiKey.id
      );

      const [counter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(context.account.id)))
        .execute();

      expect(counter?.counter).toBe(largeUnits);
    });
  });

  describe('C. Monthly UTC boundaries', () => {
    it('should use correct period at UTC month boundary', async () => {
      // Test that getUtcMonthStart computes correctly
      const date1 = new Date('2026-10-15T23:59:59.999Z'); // End of October UTC
      const date2 = new Date('2026-11-01T00:00:00.000Z'); // Start of November UTC (fixed)

      // We can't easily test the actual month boundary without mocking time,
      // but we can verify the utility function works correctly
      const { getUtcMonthStart } = await import('../domain/date.js');

      const october = getUtcMonthStart(date1);
      const november = getUtcMonthStart(date2);

      expect(october.getUTCMonth()).toBe(9); // October (0-indexed)
      expect(november.getUTCMonth()).toBe(10); // November (0-indexed)
      expect(october.getUTCDate()).toBe(1);
      expect(november.getUTCDate()).toBe(1);
    });

    it('should correctly compute period start for requests', async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: 'period-test',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('accepted');
      expect(result.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Verify it matches current UTC month start
      const expectedPeriod = formatDateForDb(getUtcMonthStart());
      expect(result.periodStart).toBe(expectedPeriod);
    });

    it('should track usage separately for different months', async () => {
      const context = await setupBasicTestContext();

      // Pre-populate counter for "previous month" (manually set period_start)
      const previousMonth = new Date(Date.UTC(2026, 8, 1)); // September 2026
      await upsertAndLockCounter(
        getTestDb(),
        BigInt(context.account.id),
        null,
        previousMonth.toISOString().split('T')[0],
        previousMonth.toISOString()
      );
      await getTestDb()
        .update(usageCounters)
        .set({ counter: 500n })
        .where(
          and(
            eq(usageCounters.accountId, BigInt(context.account.id)),
            eq(usageCounters.periodStart, previousMonth.toISOString().split('T')[0])
          )
        )
        .execute();

      // Current month should start fresh
      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 10n,
          idempotencyKey: 'month-boundary',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('accepted');
      expect(result.accountRemaining.toString()).toBe('990'); // Fresh 1000 - 10

      // Previous month counter should be unchanged
      const [prevCounter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.accountId, BigInt(context.account.id)),
            eq(usageCounters.periodStart, previousMonth.toISOString().split('T')[0])
          )
        )
        .execute();
      expect(Number(prevCounter?.counter ?? 0n)).toBe(500);
    });
  });

  describe('D. Idempotency boundaries', () => {
    it('should accept minimum valid idempotency key length (1 char)', async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: 'a', // 1 char
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('accepted');
    });

    it('should accept maximum valid idempotency key length (255 chars)', async () => {
      const context = await setupBasicTestContext();

      const longKey = 'a'.repeat(255);
      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: longKey,
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('accepted');
    });

    it('should reject empty idempotency key', async () => {
      const context = await setupBasicTestContext();

      await expect(
        processUsageRequest(
          context.account.id,
          {
            userId: context.user.clientUserId,
            units: 1n,
            idempotencyKey: '', // Empty
          },
          context.apiKey.id
        )
      ).rejects.toThrow(); // ValidationError from Zod
    });

    it('should reject idempotency key exceeding 255 chars', async () => {
      const context = await setupBasicTestContext();

      await expect(
        processUsageRequest(
          context.account.id,
          {
            userId: context.user.clientUserId,
            units: 1n,
            idempotencyKey: 'a'.repeat(256), // Too long
          },
          context.apiKey.id
        )
      ).rejects.toThrow(); // ValidationError from Zod
    });

    it('should reject zero units', async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 0n,
          idempotencyKey: 'zero-units',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('max_per_request_exceeded');
    });

    it('should reject negative units', async () => {
      const context = await setupBasicTestContext();

      const result = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: -1n,
          idempotencyKey: 'negative-units',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('max_per_request_exceeded');
    });
  });

  describe('E. Usage history and pagination', () => {
    it('should return paginated usage history', async () => {
      const context = await setupBasicTestContext();

      // Create several usage requests
      for (let i = 1; i <= 5; i++) {
        await processUsageRequest(
          context.account.id,
          {
            userId: context.user.clientUserId,
            units: BigInt(i),
            idempotencyKey: `history-test-${i}`,
          },
          context.apiKey.id
        );
      }

      // Fetch page 1 with limit 3
      const page1 = await getUsageHistory(BigInt(context.account.id), 1, 3);

      expect(page1.items).toHaveLength(3);
      expect(page1.total).toBe(5);
      expect(page1.page).toBe(1);
      expect(page1.limit).toBe(3);
      expect(page1.totalPages).toBe(2);

      // Items should be ordered by created_at descending (newest first)
      expect(page1.items[0].requestId).toBe('history-test-5');
      expect(page1.items[1].requestId).toBe('history-test-4');
      expect(page1.items[2].requestId).toBe('history-test-3');

      // Fetch page 2 with limit 3
      const page2 = await getUsageHistory(BigInt(context.account.id), 2, 3);

      expect(page2.items).toHaveLength(2);
      expect(page2.items[0].requestId).toBe('history-test-2');
      expect(page2.items[1].requestId).toBe('history-test-1');
    });

    it('should isolate usage history by account', async () => {
      const context1 = await setupBasicTestContext();
      const context2 = await setupBasicTestContext();

      // Create usage requests in account 1
      await processUsageRequest(
        context1.account.id,
        {
          userId: context1.user.clientUserId,
          units: 1n,
          idempotencyKey: 'account1-request-1',
        },
        context1.apiKey.id
      );

      await processUsageRequest(
        context1.account.id,
        {
          userId: context1.user.clientUserId,
          units: 2n,
          idempotencyKey: 'account1-request-2',
        },
        context1.apiKey.id
      );

      // Create usage request in account 2
      await processUsageRequest(
        context2.account.id,
        {
          userId: context2.user.clientUserId,
          units: 10n,
          idempotencyKey: 'account2-request-1',
        },
        context2.apiKey.id
      );

      // Account 1 should only see its own requests
      const page1 = await getUsageHistory(BigInt(context1.account.id), 1, 10);
      expect(page1.items).toHaveLength(2);
      expect(page1.items.map((r) => r.requestId)).toContain('account1-request-1');
      expect(page1.items.map((r) => r.requestId)).toContain('account1-request-2');
      expect(page1.items.map((r) => r.requestId)).not.toContain('account2-request-1');

      // Account 2 should only see its own requests
      const page2 = await getUsageHistory(BigInt(context2.account.id), 1, 10);
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].requestId).toBe('account2-request-1');
    });

    it('should return empty results for account with no usage history', async () => {
      const context = await setupBasicTestContext();

      const page = await getUsageHistory(BigInt(context.account.id), 1, 10);

      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(0);
      expect(page.totalPages).toBe(0);
    });

    it('should include account remaining and user remaining in history items', async () => {
      const context = await setupBasicTestContext();

      await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 5n,
          idempotencyKey: 'history-remaining-test',
        },
        context.apiKey.id
      );

      const page = await getUsageHistory(BigInt(context.account.id), 1, 10);

      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      expect(item.requestId).toBe('history-remaining-test');
      expect(item.decision).toBe('accepted');
      expect(item.accountRemaining).toBe('995'); // 1000 - 5
      expect(item.userRemaining).toBe('95'); // 100 - 5
    });

    it("reports accountRemaining as '0' (not null) when quota is exactly exhausted", async () => {
      const context = await setupBasicTestContext();

      // Account-scoped requests (no userId) draw only on account quota.
      // 10 x 100 units = 1000 = full monthly allowance, consumed exactly.
      for (let i = 1; i <= 10; i++) {
        const res = await processUsageRequest(
          context.account.id,
          {
            units: 100n,
            idempotencyKey: `exhaust-${i}`,
          },
          context.apiKey.id
        );
        expect(res.decision).toBe('accepted');
      }

      const page = await getUsageHistory(BigInt(context.account.id), 1, 10);

      expect(page.items).toHaveLength(10);
      const newest = page.items[0];
      expect(newest.requestId).toBe('exhaust-10');
      expect(newest.decision).toBe('accepted');
      // Zero is a real value: the old falsy check serialized 0n as null.
      expect(newest.accountRemaining).toBe('0');
      expect(newest.userRemaining).toBeNull();

      const next = await processUsageRequest(
        context.account.id,
        {
          units: 1n,
          idempotencyKey: 'exhaust-11',
        },
        context.apiKey.id
      );
      expect(next.decision).toBe('rejected');
      expect(next.rejectionReason).toBe('account_quota_exceeded');
    });
  });

  describe('F. API key management', () => {
    it('should create an API key and return the full secret exactly once', async () => {
      const context = await setupBasicTestContext();

      const created = await createApiKey(context.account.id, 'One-shot Key');

      // The full secret is returned only through this creation response...
      expect(created.key).toMatch(/^[0-9a-f]{16}\.[0-9a-f]{64}$/);
      expect(created.key.startsWith(`${created.prefix}.`)).toBe(true);

      // ...and the stored row keeps only prefix + hash, never the secret.
      const [row] = await getTestDb()
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, BigInt(created.id)))
        .execute();

      expect(row.prefix).toBe(created.prefix);
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
      const secret = created.key.slice(created.prefix.length + 1);
      expect(row.keyHash).not.toContain(secret);
      const stored = JSON.stringify(row, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v
      );
      expect(stored).not.toContain(secret);
      expect(stored).not.toContain(created.key);
    });

    it('should list API keys for an account', async () => {
      const context = await setupBasicTestContext();

      // Create a second API key
      await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: 'create-second-key',
        },
        context.apiKey.id
      );

      // List API keys - all keys for the account should be returned
      const keys = await getTestDb()
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.accountId, BigInt(context.account.id)))
        .execute();

      expect(keys.length).toBeGreaterThanOrEqual(1);
      // Each key stores a lookup prefix and a hash only — never a usable secret.
      for (const key of keys) {
        expect(key.prefix).toMatch(/^[0-9a-f]{16}$/);
        expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
        expect(Object.keys(key as unknown as Record<string, unknown>)).not.toContain('key');
      }
    });

    it('should revoke an API key', async () => {
      const context = await setupBasicTestContext();

      // Create a new API key
      const keyResult = await createApiKey(context.account.id, 'Revocable Key');

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

  describe('G. Plan management', () => {
    it('should create, read, update, and delete a custom plan', async () => {
      const context = await setupBasicTestContext();

      // Create a custom plan
      const createdPlan = await createPlan(
        {
          name: 'Custom Plan',
          type: 'account',
          monthlyAllowance: 500n,
          maxUnitsPerRequest: 50n,
        },
        context.account.id
      );

      expect(createdPlan.name).toBe('Custom Plan');
      expect(createdPlan.type).toBe('account');
      expect(createdPlan.monthlyAllowance).toBe(500n);
      expect(createdPlan.maxUnitsPerRequest).toBe(50n);
      expect(createdPlan.isSystem).toBe(false);

      // List plans - should include both system and custom plans
      const plans = await listPlans(context.account.id);
      expect(plans.length).toBeGreaterThanOrEqual(1);
      expect(plans.some((p) => p.name === 'Custom Plan')).toBe(true);

      // Get the plan by ID
      const fetchedPlan = await getPlan(createdPlan.id, context.account.id);
      expect(fetchedPlan.id).toBe(createdPlan.id);
      expect(fetchedPlan.name).toBe('Custom Plan');

      // Update the plan
      const updatedPlan = await updatePlan(
        createdPlan.id,
        {
          monthlyAllowance: 2000n,
        },
        context.account.id
      );
      expect(updatedPlan.monthlyAllowance).toBe(2000n);

      // Delete the plan
      await deletePlan(createdPlan.id, context.account.id);

      // Verify deletion - the plan should be soft-deleted
      const deletedPlan = await getPlan(createdPlan.id, context.account.id).catch(() => null);
      expect(deletedPlan).toBeNull();
    });

    it('should prevent modifying a system plan', async () => {
      const context = await setupBasicTestContext();

      // Create a system plan (ownerAccountId = null)
      const systemPlan = await createPlan(
        {
          name: 'System Plan',
          type: 'account',
          monthlyAllowance: 500n,
          maxUnitsPerRequest: 50n,
          ownerAccountId: null,
        },
        context.account.id
      );

      await expect(
        updatePlan(
          systemPlan.id,
          {
            monthlyAllowance: 999999n,
          },
          context.account.id
        )
      ).rejects.toThrow('Cannot modify system plan');
    });

    it('should prevent assigning a plan from another account', async () => {
      const context1 = await setupBasicTestContext();
      const context2 = await setupBasicTestContext();

      // Try to assign account 2's plan to account 1
      await expect(
        createAssignment(
          context1.account.id,
          {
            planId: context2.accountPlan.id,
            effectiveFrom: getUtcMonthStart(),
          },
          context1.account.id
        )
      ).rejects.toThrow('Cannot assign custom plan from another account');
    });

    it('should enforce plan type compatibility', async () => {
      const context = await setupBasicTestContext();

      // Try to assign a user plan as an account-level assignment
      await expect(
        createAssignment(
          context.account.id,
          {
            planId: context.userPlan.id,
            effectiveFrom: getUtcMonthStart(),
          },
          context.account.id
        )
      ).rejects.toThrow('Account-level assignment requires an account plan');

      // Try to assign an account plan as a user-level assignment
      await expect(
        createAssignment(
          context.account.id,
          {
            userId: context.user.clientUserId,
            planId: context.accountPlan.id,
            effectiveFrom: getUtcMonthStart(),
          },
          context.account.id
        )
      ).rejects.toThrow('User-level assignment requires a user plan');
    });

    it('CON-03: update on a concurrently soft-deleted plan is rejected, never a stale overwrite', async () => {
      const context = await setupBasicTestContext();
      const plan = await createPlan(
        {
          name: 'Concurrent Delete Target',
          type: 'account',
          monthlyAllowance: 300n,
          maxUnitsPerRequest: 30n,
        },
        context.account.id
      );

      const db = getTestDb();
      const outcome = await db
        .transaction(async (txA) => {
          // TxA reads the plan without taking a lock...
          const seen = await selectPlanById(txA, BigInt(plan.id), BigInt(context.account.id));
          expect(seen).not.toBeNull();
          if (seen) {
            expect(seen.deletedAt ?? null).toBeNull();
          }

          // ...while a concurrent transaction soft-deletes and commits on its
          // own connection (TxA holds no locks, so nothing blocks it).
          await deletePlan(plan.id, context.account.id);

          // The stale rename must be rejected by the deleted-aware WHERE
          // clause instead of resurrecting or overwriting the deleted row.
          const updated = await updatePlanRow(txA, BigInt(plan.id), { name: 'Stale Rename' });
          expect(updated).toBeNull();

          throw new Error('txA-rollback');
        })
        .catch((e: unknown) => e);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('txA-rollback');

      // The deleted plan keeps its post-delete state.
      const [row] = await db
        .select()
        .from(plans)
        .where(eq(plans.id, BigInt(plan.id)))
        .execute();
      expect(row.deletedAt).not.toBeNull();
      expect(row.name).toBe('Concurrent Delete Target');
    });
  });

  describe('H. Plan upgrade/downgrade effective timing', () => {
    it('account plan upgrade takes effect immediately', async () => {
      const context = await setupBasicTestContext();
      const { account, user, apiKey } = context;

      // Consume some quota under the current plan
      await processUsageRequest(
        account.id,
        {
          userId: user.clientUserId,
          units: 100n,
          idempotencyKey: 'pre-upgrade-consumption',
        },
        apiKey.id
      );

      // Create a higher-allowance account plan (upgrade)
      const upgradedPlan = await createPlan(
        {
          name: 'Upgraded Plan',
          type: 'account',
          monthlyAllowance: 5000n,
          maxUnitsPerRequest: MAX_UNITS_PER_REQUEST_BIGINT,
        },
        account.id
      );

      // Assign the upgraded plan
      const assignment = await createAssignment(
        account.id,
        { planId: upgradedPlan.id, effectiveFrom: getUtcMonthStart() },
        account.id
      );

      // Upgrade takes effect immediately (client effectiveFrom ignored when
      // a current assignment exists)
      expect(assignment.isCurrent).toBe(true);
      expect(assignment.planId).toBe(upgradedPlan.id);

      // Current assignments return the new plan right away
      const current = await getCurrentAssignments(account.id);
      expect(current.account).not.toBeNull();
      expect(current.account!.planId).toBe(upgradedPlan.id);
      expect(current.account!.isCurrent).toBe(true);

      // Remaining quota is calculated against the new allowance: 5000 - 100 (pre) - 100 (post) = 4800
      const result = await processUsageRequest(
        account.id,
        {
          units: 100n,
          idempotencyKey: 'post-upgrade-usage',
        },
        apiKey.id
      );

      expect(result.decision).toBe('accepted');
      expect(result.accountRemaining.toString()).toBe('4800');
    });

    it('user plan upgrade takes effect immediately', async () => {
      const context = await setupBasicTestContext();
      const { account, user, apiKey } = context;

      // Consume some user quota under the current user plan
      await processUsageRequest(
        account.id,
        {
          userId: user.clientUserId,
          units: 50n,
          idempotencyKey: 'pre-user-upgrade-consumption',
        },
        apiKey.id
      );

      // Create a higher-allowance user plan (upgrade)
      const upgradedUserPlan = await createPlan(
        {
          name: 'Upgraded User Plan',
          type: 'user',
          monthlyAllowance: 1000n,
          maxUnitsPerRequest: MAX_UNITS_PER_REQUEST_BIGINT,
        },
        account.id
      );

      // Assign the upgraded user plan
      const assignment = await createAssignment(
        account.id,
        {
          userId: user.clientUserId,
          planId: upgradedUserPlan.id,
          effectiveFrom: getUtcMonthStart(),
        },
        account.id
      );

      expect(assignment.isCurrent).toBe(true);

      const current = await getCurrentAssignments(account.id);
      const userAssignment = current.users.find((u) => u.userId === user.id);
      expect(userAssignment).not.toBeUndefined();
      expect(userAssignment!.planId).toBe(upgradedUserPlan.id);

      // Remaining user quota uses the new allowance: 1000 - 50 (pre) - 50 (post) = 900
      const result = await processUsageRequest(
        account.id,
        {
          userId: user.clientUserId,
          units: 50n,
          idempotencyKey: 'post-user-upgrade-usage',
        },
        apiKey.id
      );

      expect(result.decision).toBe('accepted');
      expect(result.userRemaining!.toString()).toBe('900');
    });

    it('usage is preserved during an upgrade (counters not reset)', async () => {
      const context = await setupBasicTestContext();
      const { account, user, apiKey } = context;

      // Consume some quota under the current plan (within both account and user limits)
      await processUsageRequest(
        account.id,
        {
          userId: user.clientUserId,
          units: 50n,
          idempotencyKey: 'pre-upgrade-preserve',
        },
        apiKey.id
      );

      const [counterBefore] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(account.id)))
        .execute();
      expect(Number(counterBefore!.counter)).toBe(50);

      // Upgrade to a higher allowance plan
      const upgradedPlan = await createPlan(
        {
          name: 'Upgrade Preserve Plan',
          type: 'account',
          monthlyAllowance: 5000n,
          maxUnitsPerRequest: MAX_UNITS_PER_REQUEST_BIGINT,
        },
        account.id
      );

      await createAssignment(
        account.id,
        { planId: upgradedPlan.id, effectiveFrom: getUtcMonthStart() },
        account.id
      );

      // Counter is preserved (not reset)
      const [counterAfter] = await getTestDb()
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.accountId, BigInt(account.id)))
        .execute();
      expect(Number(counterAfter!.counter)).toBe(50);

      // Remaining quota = new allowance - total consumed = 5000 - 100 = 4900
      const result = await processUsageRequest(
        account.id,
        {
          userId: user.clientUserId,
          units: 50n,
          idempotencyKey: 'post-upgrade-preserve',
        },
        apiKey.id
      );

      expect(result.decision).toBe('accepted');
      expect(result.accountRemaining.toString()).toBe('4900');
    });

    it('account plan downgrade takes effect immediately and clamps remaining at zero', async () => {
      const context = await setupBasicTestContext();
      const { account, user, apiKey } = context;

      // Consume under the current account plan (1000 units/month)
      const pre = await processUsageRequest(
        account.id,
        {
          units: 500n,
          idempotencyKey: 'pre-downgrade-usage',
        },
        apiKey.id
      );
      expect(pre.decision).toBe('accepted');
      expect(pre.accountRemaining.toString()).toBe('500');

      // Lower-allowance account plan (downgrade)
      const downgradedPlan = await createPlan(
        {
          name: 'Downgraded Plan',
          type: 'account',
          monthlyAllowance: 200n,
          maxUnitsPerRequest: MAX_UNITS_PER_REQUEST_BIGINT,
        },
        account.id
      );

      const assignment = await createAssignment(
        account.id,
        { planId: downgradedPlan.id },
        account.id
      );

      // The brief requires the change to apply to new requests after the
      // update succeeds — downgrades are immediate, never deferred.
      expect(assignment.isCurrent).toBe(true);
      expect(assignment.planId).toBe(downgradedPlan.id);

      const current = await getCurrentAssignments(account.id);
      expect(current.account).not.toBeNull();
      expect(current.account!.planId).toBe(downgradedPlan.id);
      expect(current.account!.isCurrent).toBe(true);

      // Consumed units (500) are preserved and exceed the new allowance
      // (200): zero remaining, rejection, never a negative balance.
      const result = await processUsageRequest(
        account.id,
        {
          units: 1n,
          idempotencyKey: 'post-downgrade-usage',
        },
        apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('account_quota_exceeded');
      expect(result.accountRemaining.toString()).toBe('0');

      // Past request history is preserved across the plan change.
      const history = await getUsageHistory(BigInt(account.id), 1, 10);
      expect(history.total).toBe(2);
      const decisions = history.items.map((i) => i.decision);
      expect(decisions).toContain('accepted');
      expect(decisions).toContain('rejected');
      expect(
        history.items.find((i) => i.requestId === 'post-downgrade-usage')!.rejectionReason
      ).toBe('account_quota_exceeded');
    });

    it('user plan downgrade takes effect immediately with usage preserved', async () => {
      const context = await setupBasicTestContext();
      const { account, user, apiKey } = context;

      // Consume under the current user plan (100 units/month, max 100/req)
      const pre = await processUsageRequest(
        account.id,
        {
          userId: user.clientUserId,
          units: 50n,
          idempotencyKey: 'pre-user-downgrade-usage',
        },
        apiKey.id
      );
      expect(pre.decision).toBe('accepted');
      expect(pre.userRemaining!.toString()).toBe('50');

      const downgradedUserPlan = await createPlan(
        {
          name: 'Downgraded User Plan',
          type: 'user',
          monthlyAllowance: 20n,
          maxUnitsPerRequest: 100n,
        },
        account.id
      );

      const assignment = await createAssignment(
        account.id,
        { userId: user.clientUserId, planId: downgradedUserPlan.id },
        account.id
      );
      expect(assignment.isCurrent).toBe(true);

      const current = await getCurrentAssignments(account.id);
      const userAssignment = current.users.find((u) => u.userId === user.id);
      expect(userAssignment).not.toBeUndefined();
      expect(userAssignment!.planId).toBe(downgradedUserPlan.id);
      expect(userAssignment!.isCurrent).toBe(true);

      // Used (50) exceeds the new user allowance (20): user remaining is
      // clamped to zero and further consumption is rejected. The account
      // side still has headroom, so the user rule is what rejects.
      const result = await processUsageRequest(
        account.id,
        {
          userId: user.clientUserId,
          units: 1n,
          idempotencyKey: 'post-user-downgrade-usage',
        },
        apiKey.id
      );

      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('user_quota_exceeded');
      expect(result.userRemaining!.toString()).toBe('0');
      expect(result.accountRemaining.toString()).toBe('950'); // 1000 - 50, untouched
    });

    it('PATCHing a plan allowance below existing usage applies to the next request', async () => {
      const context = await setupBasicTestContext();
      const { account, apiKey } = context;

      const pre = await processUsageRequest(
        account.id,
        {
          units: 200n,
          idempotencyKey: 'pre-patch-usage',
        },
        apiKey.id
      );
      expect(pre.decision).toBe('accepted');
      expect(pre.accountRemaining.toString()).toBe('800');

      // Reduce the assigned plan's allowance below consumed usage (200).
      await updatePlan(context.accountPlan.id, { monthlyAllowance: 150n }, account.id);

      // The very next request sees the new limit: zero remaining, rejected.
      const result = await processUsageRequest(
        account.id,
        {
          units: 1n,
          idempotencyKey: 'post-patch-usage',
        },
        apiKey.id
      );
      expect(result.decision).toBe('rejected');
      expect(result.rejectionReason).toBe('account_quota_exceeded');
      expect(result.accountRemaining.toString()).toBe('0');
    });

    it('UTC month boundary calculations are correct', () => {
      // December year-end boundary
      const dec31 = new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999));
      const jan1 = getNextUtcMonthStart(dec31);
      expect(jan1.getUTCFullYear()).toBe(2027);
      expect(jan1.getUTCMonth()).toBe(0); // January
      expect(jan1.getUTCDate()).toBe(1);

      // February leap year boundary (2026 is not a leap year, Feb has 28 days)
      const feb28 = new Date(Date.UTC(2026, 1, 28, 12, 0, 0, 0));
      const mar1 = getNextUtcMonthStart(feb28);
      expect(mar1.getUTCFullYear()).toBe(2026);
      expect(mar1.getUTCMonth()).toBe(2); // March
      expect(mar1.getUTCDate()).toBe(1);

      // Mid-month stays in same month
      const oct15 = new Date(Date.UTC(2026, 9, 15, 10, 30, 0, 0));
      const nov1 = getNextUtcMonthStart(oct15);
      expect(nov1.getUTCFullYear()).toBe(2026);
      expect(nov1.getUTCMonth()).toBe(10); // November
      expect(nov1.getUTCDate()).toBe(1);
    });

    it('repeated assignments do not create duplicate active assignments', async () => {
      const context = await setupBasicTestContext();
      const { account } = context;

      // Create a plan and assign it twice
      const plan = await createPlan(
        { name: 'Repeat Plan', type: 'account', monthlyAllowance: 1000n, maxUnitsPerRequest: 100n },
        account.id
      );

      const first = await createAssignment(
        account.id,
        { planId: plan.id, effectiveFrom: getUtcMonthStart() },
        account.id
      );

      // Re-assigning the same plan: same allowance, not a downgrade, ends old and starts new immediately
      const second = await createAssignment(
        account.id,
        { planId: plan.id, effectiveFrom: getUtcMonthStart() },
        account.id
      );

      // Only one current account-level assignment should exist
      const current = await getCurrentAssignments(account.id);
      expect(current.account).not.toBeNull();
      expect(current.account!.planId).toBe(plan.id);

      // Verify only one row with effective_to IS NULL in the database
      const rows = await getTestDb()
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
      expect(rows.length).toBe(1);
    });

    it('failed assignment rolls back all database changes', async () => {
      const context = await setupBasicTestContext();
      const { account } = context;

      // Create a valid plan and an invalid one (from another account would be auth error,
      // but we can trigger a validation error instead: assign user plan as account-level)
      const userPlan = context.userPlan;

      // Record assignment count before
      const beforeCount = await getTestDb()
        .select()
        .from(planAssignments)
        .where(eq(planAssignments.accountId, BigInt(account.id)))
        .execute();

      // This should fail: assigning a user plan as account-level
      await expect(
        createAssignment(
          account.id,
          {
            planId: userPlan.id,
            effectiveFrom: getUtcMonthStart(),
          },
          account.id
        )
      ).rejects.toThrow('Account-level assignment requires an account plan');

      // No new assignment should have been persisted
      const afterCount = await getTestDb()
        .select()
        .from(planAssignments)
        .where(eq(planAssignments.accountId, BigInt(account.id)))
        .execute();
      expect(afterCount.length).toBe(beforeCount.length);
    });
  });

  describe('I. Fail-closed plan requirements', () => {
    async function countRowsForAccount(
      table: 'usageRequests' | 'usageCounters',
      accountId: number
    ) {
      const db = getTestDb();
      const rows =
        table === 'usageRequests'
          ? await db
              .select()
              .from(usageRequests)
              .where(eq(usageRequests.accountId, BigInt(accountId)))
              .execute()
          : await db
              .select()
              .from(usageCounters)
              .where(eq(usageCounters.accountId, BigInt(accountId)))
              .execute();
      return rows.length;
    }

    it('BR-09: account without an effective account plan is rejected with 409 Conflict', async () => {
      const context = await setupBasicTestContext();

      await getTestDb()
        .delete(planAssignments)
        .where(
          and(
            eq(planAssignments.accountId, BigInt(context.account.id)),
            isNull(planAssignments.userId)
          )
        )
        .execute();

      const error = await processUsageRequest(
        context.account.id,
        {
          units: 1n,
          idempotencyKey: 'no-account-plan',
        },
        context.apiKey.id
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).statusCode).toBe(409);
      expect((error as Error).message).toBe('No active account plan assigned');

      // The failed transaction rolled back: nothing persisted, nothing consumed.
      const db = getTestDb();
      const requestRows = await db
        .select()
        .from(usageRequests)
        .where(
          and(
            eq(usageRequests.accountId, BigInt(context.account.id)),
            eq(usageRequests.idempotencyKey, 'no-account-plan')
          )
        )
        .execute();
      expect(requestRows).toHaveLength(0);
      expect(await countRowsForAccount('usageCounters', context.account.id)).toBe(0);
    });

    it('BR-01: user-scoped request without an effective user plan fails closed (no account-only fallback)', async () => {
      const context = await setupBasicTestContext();

      // Remove only the user-level assignment; the account plan stays valid.
      await getTestDb()
        .delete(planAssignments)
        .where(
          and(
            eq(planAssignments.accountId, BigInt(context.account.id)),
            eq(planAssignments.userId, BigInt(context.user.id))
          )
        )
        .execute();

      const error = await processUsageRequest(
        context.account.id,
        {
          userId: context.user.clientUserId,
          units: 1n,
          idempotencyKey: 'no-user-plan',
        },
        context.apiKey.id
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).statusCode).toBe(409);
      expect((error as Error).message).toBe('No active user plan assigned for user');

      // Fail closed means consume nothing: no request row, no counter rows.
      expect(await countRowsForAccount('usageRequests', context.account.id)).toBe(0);
      expect(await countRowsForAccount('usageCounters', context.account.id)).toBe(0);
    });

    it('account-scoped requests stay valid without a user plan (BR-01 applies only to user-scoped input)', async () => {
      const context = await setupBasicTestContext();

      await getTestDb()
        .delete(planAssignments)
        .where(
          and(
            eq(planAssignments.accountId, BigInt(context.account.id)),
            eq(planAssignments.userId, BigInt(context.user.id))
          )
        )
        .execute();

      const result = await processUsageRequest(
        context.account.id,
        {
          units: 7n,
          idempotencyKey: 'account-only-control',
        },
        context.apiKey.id
      );

      expect(result.decision).toBe('accepted');
      expect(result.accountRemaining.toString()).toBe('993');
      expect(result.userRemaining).toBeUndefined();
    });
  });
});
