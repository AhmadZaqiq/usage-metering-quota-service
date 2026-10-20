import {
  selectAccountByName,
  insertAccount,
} from "../infrastructure/repositories/accountRepository.js";
import {
  selectPlanByAccountAndName,
} from "../infrastructure/repositories/planRepository.js";
import {
  deleteAssignmentsByAccount,
  selectCurrentAssignmentByUser,
} from "../infrastructure/repositories/assignmentRepository.js";
import {
  selectUserByAccountAndClientUserId,
  insertUser,
} from "../infrastructure/repositories/userRepository.js";
import { createApiKey, revokeApiKey } from "../application/auth/apiKeyService.js";
import { selectActiveApiKeyByName } from "../infrastructure/repositories/apiKeyRepository.js";
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
    try {
      const account = await insertAccount(db, env.BOOTSTRAP_ACCOUNT_NAME);
      accountId = account.id;
      logger.info({ accountId: accountId.toString() }, "Bootstrap account created");
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code !== "23505") throw err;
      const raced = await selectAccountByName(db, env.BOOTSTRAP_ACCOUNT_NAME);
      if (!raced) throw err;
      accountId = raced.id;
      logger.info({ accountId: accountId.toString() }, "Bootstrap account created concurrently; reusing");
    }
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

  // Create test users: --users N on the load test rotates across
  // loadtest-user-1..N (each with its own user plan so multiple users can
  // contend for the shared account pool). LOADTEST_USERS controls how many
  // (default 10). The legacy loadtest-user remains for older commands.
  const userCountRaw = process.env.LOADTEST_USERS ?? "10";
  const userCount = Number.parseInt(userCountRaw, 10);
  if (!Number.isInteger(userCount) || userCount < 1 || userCount > 100) {
    logger.error({ userCountRaw }, "LOADTEST_USERS must be an integer between 1 and 100");
    process.exit(1);
  }

  const clientUserIds = ["loadtest-user", ...Array.from({ length: userCount }, (_, i) => `loadtest-user-${i + 1}`)];
  const createdUsers: string[] = [];
  let assignedUsers = 0;
  for (const clientUserId of clientUserIds) {
    let userRow = await selectUserByAccountAndClientUserId(db, BigInt(accountId), clientUserId);
    if (!userRow) {
      userRow = await insertUser(db, BigInt(accountId), clientUserId);
      createdUsers.push(clientUserId);
    }
    // Assign only when no plan is in effect (first run, or the old plan was
    // removed): re-running bootstrap must not stack superseded history rows
    // on every container restart.
    const current = await selectCurrentAssignmentByUser(db, userRow.id);
    if (!current) {
      await createAssignment(
        Number(accountId),
        { userId: clientUserId, planId: userPlanId, effectiveFrom },
        Number(accountId)
      );
      assignedUsers += 1;
    }
  }
  logger.info(
    { users: clientUserIds.length, created: createdUsers.length, assigned: assignedUsers },
    "Load-test users ensured with user plan coverage"
  );

  // Create API key: rotate instead of accumulating one key per run. The
  // load-test script must print a usable secret, and only the first full key
  // is ever returned at creation time, so a fresh key is minted and any
  // previous active key with the same name is revoked.
  const activeKey = await selectActiveApiKeyByName(db, BigInt(accountId), env.BOOTSTRAP_API_KEY_NAME);
  if (activeKey) {
    await revokeApiKey(Number(accountId), Number(activeKey.id));
    logger.info({ prefix: activeKey.prefix }, "Revoked previous load-test API key");
  }
  const keyResult = await createApiKey(Number(accountId), env.BOOTSTRAP_API_KEY_NAME);
  logger.info({ prefix: keyResult.prefix }, "Bootstrap API key created");

  console.log("\n=== BOOTSTRAP COMPLETE ===");
  console.log(`Account: ${env.BOOTSTRAP_ACCOUNT_NAME} (ID: ${accountId})`);
  console.log(`Test Users: loadtest-user, loadtest-user-1..loadtest-user-${userCount}`);
  console.log(`Account Plan: Load Test Account Plan (1,000,000 units/month)`);
  console.log(`User Plan: Load Test User Plan (100,000 units/month)`);
  console.log("\n=== LOAD TEST API KEY (save this - shown only once) ===");
  console.log(keyResult.key);
  console.log("========================================================\n");
  console.log("To run load test:");
  console.log(`  export LOADTEST_API_KEY=${keyResult.key}`);
  console.log("  npm run loadtest -- --duration 30 --connections 10");
  console.log("  npm run loadtest -- --users 10 --duration 30 --connections 10");
  console.log("  npm run loadtest -- --duplicate-every 5 --duration 30");
  console.log("  npm run loadtest -- --near-quota --headroom 50 --duration 30");
  console.log("After a run: docker compose run --rm app node dist/scripts/verify-invariants.js");
  console.log("========================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Bootstrap failed");
    process.exit(1);
  });
