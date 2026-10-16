import { db } from "../db/client.js";
import { accounts, users, plans, planAssignments } from "../db/schema/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { createApiKey } from "../modules/auth/apiKeyService.js";
import { createPlan } from "../modules/plans/planService.js";
import { createAssignment } from "../modules/plans/assignmentService.js";
import { getEnv } from "../config/index.js";
import { getUtcMonthStart } from "../utils/date.js";
import { logger } from "../logging/logger.js";

async function main() {
  const env = getEnv();

  if (!env.BOOTSTRAP_ACCOUNT_NAME || !env.BOOTSTRAP_API_KEY_NAME) {
    logger.info("Bootstrap skipped: BOOTSTRAP_ACCOUNT_NAME and BOOTSTRAP_API_KEY_NAME not set");
    console.log("\nTo run load tests, set these environment variables:");
    console.log("  BOOTSTRAP_ACCOUNT_NAME=loadtest-account");
    console.log("  BOOTSTRAP_API_KEY_NAME=loadtest-key");
    console.log("Then run: npm run bootstrap\n");
    process.exit(0);
  }

  // Create or get bootstrap account
  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.name, env.BOOTSTRAP_ACCOUNT_NAME))
    .limit(1)
    .execute();

  let accountId: bigint;

  if (existing.length > 0) {
    accountId = existing[0].id;
    logger.info({ accountId: accountId.toString() }, "Bootstrap account already exists");
  } else {
    const [account] = await db
      .insert(accounts)
      .values({ name: env.BOOTSTRAP_ACCOUNT_NAME })
      .returning({ id: accounts.id })
      .execute();
    accountId = account.id;
    logger.info({ accountId: accountId.toString() }, "Bootstrap account created");
  }

  // Create account plan
  let accountPlanId: number;
  const existingPlan = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.ownerAccountId, accountId), eq(plans.name, "Load Test Account Plan")))
    .limit(1)
    .execute();

  if (existingPlan.length > 0) {
    accountPlanId = Number(existingPlan[0].id);
  } else {
    const plan = await createPlan(
      { name: "Load Test Account Plan", type: "account", monthlyAllowance: 1_000_000n, maxUnitsPerRequest: 10000n },
      Number(accountId)
    );
    accountPlanId = Number(plan.id);
    logger.info({ planId: accountPlanId }, "Account plan created");
  }

  // Create user plan
  let userPlanId: number;
  const existingUserPlan = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.ownerAccountId, accountId), eq(plans.name, "Load Test User Plan")))
    .limit(1)
    .execute();

  if (existingUserPlan.length > 0) {
    userPlanId = Number(existingUserPlan[0].id);
  } else {
    const plan = await createPlan(
      { name: "Load Test User Plan", type: "user", monthlyAllowance: 100_000n, maxUnitsPerRequest: 10000n },
      Number(accountId)
    );
    userPlanId = Number(plan.id);
    logger.info({ planId: userPlanId }, "User plan created");
  }

  // Assign account plan
  const effectiveFrom = getUtcMonthStart();
  await db
    .delete(planAssignments)
    .where(and(eq(planAssignments.accountId, accountId), isNull(planAssignments.userId)))
    .execute();

  await createAssignment(Number(accountId), { planId: accountPlanId, effectiveFrom }, Number(accountId));
  logger.info("Account plan assigned");

  // Create test user
  let userId: bigint;
  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.accountId, accountId), eq(users.clientUserId, "loadtest-user")))
    .limit(1)
    .execute();

  if (existingUser.length > 0) {
    userId = existingUser[0].id;
  } else {
    const [user] = await db
      .insert(users)
      .values({ accountId, clientUserId: "loadtest-user" })
      .returning({ id: users.id })
      .execute();
    userId = user.id;
    logger.info({ userId: userId.toString() }, "Test user created");
  }

  // Assign user plan
  await createAssignment(Number(accountId), { userId: "loadtest-user", planId: userPlanId, effectiveFrom }, Number(accountId));
  logger.info("User plan assigned");

  // Create API key
  const keyResult = await createApiKey(Number(accountId), env.BOOTSTRAP_API_KEY_NAME);
  logger.info({ prefix: keyResult.prefix }, "Bootstrap API key created");

  console.log("\n=== BOOTSTRAP COMPLETE ===");
  console.log(`Account: ${env.BOOTSTRAP_ACCOUNT_NAME} (ID: ${accountId})`);
  console.log(`Test User: loadtest-user (ID: ${userId})`);
  console.log(`Account Plan: Load Test Account Plan (1,000,000 units/month)`);
  console.log(`User Plan: Load Test User Plan (100,000 units/month)`);
  console.log("\n=== LOAD TEST API KEY (save this - shown only once) ===");
  console.log(keyResult.key);
  console.log("========================================================\n");
  console.log("To run load test:");
  console.log(`  export LOADTEST_API_KEY=${keyResult.key}`);
  console.log("  npm run loadtest\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Bootstrap failed");
    process.exit(1);
  });