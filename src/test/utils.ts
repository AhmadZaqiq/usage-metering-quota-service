import { getTestDb } from "./setup.js";
import { accounts, users, plans, planAssignments, apiKeys, usageCounters, usageRequests } from "../db/schema/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { createApiKey } from "../modules/auth/apiKeyService.js";
import { createPlan } from "../modules/plans/planService.js";
import { createAssignment } from "../modules/plans/assignmentService.js";
import { processUsageRequest } from "../modules/usage/usageService.js";
import { formatDateForDb, getUtcMonthStart } from "../utils/date.js";

export interface TestAccount {
  id: number;
  name: string;
}

export interface TestUser {
  id: number;
  clientUserId: string;
}

export interface TestPlan {
  id: number;
  name: string;
  type: "account" | "user";
  monthlyAllowance: bigint;
  maxUnitsPerRequest: bigint;
}

export interface TestApiKey {
  id: number;
  prefix: string;
  key: string;
}

export interface TestContext {
  account: { id: number; name: string };
  user: { id: number; clientUserId: string };
  accountPlan: { id: number; name: string; type: "account" | "user"; monthlyAllowance: bigint; maxUnitsPerRequest: bigint };
  userPlan: { id: number; name: string; type: "account" | "user"; monthlyAllowance: bigint; maxUnitsPerRequest: bigint };
  apiKey: { id: number; prefix: string; key: string };
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

export async function makeUsageRequest(
  accountId: number,
  apiKeyId: number,
  input: { userId?: string; units: bigint; idempotencyKey: string }
) {
  return processUsageRequest(accountId, input, apiKeyId);
}

export async function getAccountCounter(accountId: number) {
  const periodStart = formatDateForDb(getUtcMonthStart());
  const db = getTestDb();
  const [counter] = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.accountId, BigInt(accountId)), eq(usageCounters.periodStart, periodStart)))
    .execute();
  return counter?.counter ?? 0n;
}

export async function getUsageRequestRecord(accountId: number, idempotencyKey: string) {
  const db = getTestDb();
  const [record] = await db
    .select()
    .from(usageRequests)
    .where(and(eq(usageRequests.accountId, BigInt(accountId)), eq(usageRequests.idempotencyKey, idempotencyKey)))
    .execute();
  return record;
}

export async function getCounters(accountId: number) {
  const db = getTestDb();
  return db
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.accountId, BigInt(accountId)))
    .execute();
}