import {
  selectAccountByName,
  insertAccount,
} from "../infrastructure/repositories/accountRepository.js";
import {
  selectPlanByAccountAndName,
} from "../infrastructure/repositories/planRepository.js";
import {
  deleteAssignmentsByAccount,
  selectCurrentAssignmentByAccount,
} from "../infrastructure/repositories/assignmentRepository.js";
import {
  selectUserByAccountAndClientUserId,
  insertUser,
} from "../infrastructure/repositories/userRepository.js";
import { createApiKey } from "../application/auth/apiKeyService.js";
import { createAssignment } from "../application/plans/assignmentService.js";
import { createPlan } from "../application/plans/planService.js";
import { getEnv } from "../config/index.js";
import { getUtcMonthStart } from "../domain/date.js";
import { logger } from "../logging/logger.js";
import { db } from "../db/client.js";

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
  const existing = await selectAccountByName(db, env.BOOTSTRAP_ACCOUNT_NAME);

  let accountId: bigint;

  if (existing) {
    accountId = existing.id;
    logger.info({ accountId: accountId.toString() }, "Bootstrap account already exists");
  } else {
    const account = await insertAccount(db, env.BOOTSTRAP_ACCOUNT_NAME);
    accountId = account.id;
    logger.info({ accountId: accountId.toString() }, "Bootstrap account created");
  }

  // Create account plan
  let accountPlanId: number;
  const existingPlan = await selectPlanByAccountAndName(db, accountId, "Load Test Account Plan");

  if (existingPlan) {
    accountPlanId = Number(existingPlan.id);
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
  const existingUserPlan = await selectPlanByAccountAndName(db, accountId, "Load Test User Plan");

  if (existingUserPlan) {
    userPlanId = Number(existingUserPlan.id);
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
  await deleteAssignmentsByAccount(db, BigInt(accountId));

  await createAssignment(Number(accountId), { planId: accountPlanId, effectiveFrom }, Number(accountId));
  logger.info("Account plan assigned");

  // Create test user
  let userId: bigint;
  const existingUser = await selectUserByAccountAndClientUserId(db, BigInt(accountId), "loadtest-user");

  if (existingUser) {
    userId = existingUser.id;
  } else {
    const user = await insertUser(db, BigInt(accountId), "loadtest-user");
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
