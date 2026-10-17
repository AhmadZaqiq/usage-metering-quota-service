import {
  selectAccountByName,
  insertAccount,
} from "../modules/accounts/accountRepository.js";
import {
  selectPlanByAccountAndName,
} from "../modules/plans/planRepository.js";
import {
  selectCurrentAssignmentByAccount,
} from "../modules/plans/assignmentRepository.js";
import { createApiKey } from "../modules/auth/apiKeyService.js";
import { createAssignment } from "../modules/plans/assignmentService.js";
import { createPlan } from "../modules/plans/planService.js";
import { getEnv, MAX_UNITS_PER_REQUEST_BIGINT } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { getUtcMonthStart } from "../utils/date.js";
import * as fs from "fs";
import { db } from "../db/client.js";

const DEFAULT_PLAN_NAME = "Default Plan";
const DEFAULT_MONTHLY_ALLOWANCE = 10_000n;

async function ensureDefaultPlan(accountId: bigint): Promise<number> {
  const existing = await selectPlanByAccountAndName(db, accountId, DEFAULT_PLAN_NAME);

  if (existing) {
    return Number(existing.id);
  }

  const plan = await createPlan(
    {
      name: DEFAULT_PLAN_NAME,
      type: "account",
      monthlyAllowance: DEFAULT_MONTHLY_ALLOWANCE,
      maxUnitsPerRequest: MAX_UNITS_PER_REQUEST_BIGINT,
    },
    Number(accountId as unknown as number)
  );

  return plan.id;
}

async function ensureDefaultAssignment(accountId: bigint, planId: number): Promise<void> {
  const current = await selectCurrentAssignmentByAccount(db, accountId);

  if (current) {
    return;
  }

  await createAssignment(Number(accountId as unknown as number), {
    planId,
    effectiveFrom: getUtcMonthStart(),
  }, Number(accountId as unknown as number));
}

export async function bootstrap(): Promise<void> {
  const env = getEnv();

  const bootstrapAccountName = process.env.BOOTSTRAP_ACCOUNT_NAME;
  const bootstrapApiKeyName = process.env.BOOTSTRAP_API_KEY_NAME;

  if (!bootstrapAccountName || !bootstrapApiKeyName) {
    logger.info("Bootstrap skipped: BOOTSTRAP_ACCOUNT_NAME and BOOTSTRAP_API_KEY_NAME not set");
    return;
  }

  const existing = await selectAccountByName(db, bootstrapAccountName);

  let accountId: bigint;

  if (existing) {
    accountId = existing.id;
    logger.info({ accountId: accountId.toString() }, "Bootstrap account already exists");
  } else {
    const account = await insertAccount(db, bootstrapAccountName);
    accountId = account.id;
    logger.info({ accountId: accountId.toString() }, "Bootstrap account created");
  }

  const planId = await ensureDefaultPlan(accountId);
  await ensureDefaultAssignment(accountId, planId);

  const keyResult = await createApiKey(    Number(accountId as unknown as number), bootstrapApiKeyName);
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
