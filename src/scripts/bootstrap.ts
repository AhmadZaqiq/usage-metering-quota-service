import { db } from "../db/client.js";
import { accounts, apiKeys, plans, planAssignments } from "../db/schema/index.js";
import { and, eq, isNull } from "drizzle-orm";
import { createApiKey } from "../modules/auth/apiKeyService.js";
import { createAssignment } from "../modules/plans/assignmentService.js";
import { createPlan } from "../modules/plans/planService.js";
import { getEnv, MAX_UNITS_PER_REQUEST_BIGINT } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { getUtcMonthStart } from "../utils/date.js";
import * as fs from "fs";

const DEFAULT_PLAN_NAME = "Default Plan";
const DEFAULT_MONTHLY_ALLOWANCE = 10_000n;

async function ensureDefaultPlan(accountId: number): Promise<number> {
  const existing = await db
    .select({ id: plans.id })
    .from(plans)
    .where(
      and(
        eq(plans.ownerAccountId, BigInt(accountId)),
        eq(plans.name, DEFAULT_PLAN_NAME),
        isNull(plans.deletedAt)
      )
    )
    .limit(1)
    .execute();

  if (existing.length > 0) {
    return Number(existing[0].id);
  }

  const plan = await createPlan(
    {
      name: DEFAULT_PLAN_NAME,
      type: "account",
      monthlyAllowance: DEFAULT_MONTHLY_ALLOWANCE,
      maxUnitsPerRequest: MAX_UNITS_PER_REQUEST_BIGINT,
    },
    accountId
  );

  return plan.id;
}

async function ensureDefaultAssignment(accountId: number, planId: number): Promise<void> {
  const current = await db
    .select({ id: planAssignments.id })
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

  if (current.length > 0) {
    return;
  }

  await createAssignment(accountId, {
    planId,
    effectiveFrom: getUtcMonthStart(),
  }, accountId);
}

export async function bootstrap(): Promise<void> {
  const env = getEnv();

  const bootstrapAccountName = process.env.BOOTSTRAP_ACCOUNT_NAME;
  const bootstrapApiKeyName = process.env.BOOTSTRAP_API_KEY_NAME;

  if (!bootstrapAccountName || !bootstrapApiKeyName) {
    logger.info("Bootstrap skipped: BOOTSTRAP_ACCOUNT_NAME and BOOTSTRAP_API_KEY_NAME not set");
    return;
  }

  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.name, bootstrapAccountName))
    .limit(1)
    .execute();

  let accountId: bigint;

  if (existing.length > 0) {
    accountId = existing[0].id;
    logger.info({ accountId: accountId.toString() }, "Bootstrap account already exists");
  } else {
    const [account] = await db
      .insert(accounts)
      .values({ name: bootstrapAccountName })
      .returning({ id: accounts.id })
      .execute();
    accountId = account.id;
    logger.info({ accountId: accountId.toString() }, "Bootstrap account created");
  }

  const planId = await ensureDefaultPlan(Number(accountId));
  await ensureDefaultAssignment(Number(accountId), planId);

  const keyResult = await createApiKey(Number(accountId), bootstrapApiKeyName);
  logger.info({ prefix: keyResult.prefix }, "Bootstrap API key created");

  // Persist the bootstrapped key to the shared secrets volume so the client
  // container can pick it up. Best-effort: skipped when /run/secrets is not
  // available (e.g. local development), where the key is shown on stdout.
  try {
    fs.writeFileSync("/run/secrets/api-key", keyResult.key);
  } catch {
    // Secret file not writable in this environment; key is shown on stdout.
  }

  console.log("\n=== BOOTSTRAP API KEY (save this - shown only once) ===");
  console.log(keyResult.key);
  console.log("========================================================\n");
}

async function main() {
  await bootstrap();
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error({ err }, "Bootstrap failed");
    process.exit(1);
  });
}