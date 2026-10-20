import {
  selectAccountByName,
  insertAccount,
} from "../infrastructure/repositories/accountRepository.js";
import {
  selectSystemPlanByTypeAndName,
  insertPlan,
} from "../infrastructure/repositories/planRepository.js";
import {
  selectActiveApiKeyByName,
} from "../infrastructure/repositories/apiKeyRepository.js";
import {
  selectCurrentAssignmentByAccount,
} from "../infrastructure/repositories/assignmentRepository.js";
import { createApiKey, revokeApiKey } from "../application/auth/apiKeyService.js";
import { createAssignment } from "../application/plans/assignmentService.js";
import { getEnv } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { getUtcMonthStart } from "../domain/date.js";
import { unwrapQueryError } from "../domain/pgError.js";
import * as fs from "fs";
import { db } from "../db/client.js";

// Predefined, account-owned plans available to every account. Seeded
// idempotently on a fresh install so the read-only /plans catalog and default
// assignment have real data instead of an empty system-plan set. Owner is
// null, so planService treats them as read-only for every tenant.
const SYSTEM_PLANS = [
  { name: "Starter", type: "account", monthlyAllowance: 10_000n, maxUnitsPerRequest: 100n },
  { name: "Pro", type: "account", monthlyAllowance: 1_000_000n, maxUnitsPerRequest: 1_000n },
  { name: "Basic", type: "user", monthlyAllowance: 500n, maxUnitsPerRequest: 20n },
  { name: "Premium", type: "user", monthlyAllowance: 5_000n, maxUnitsPerRequest: 200n },
] as const;

async function ensureSystemPlans(): Promise<void> {
  for (const plan of SYSTEM_PLANS) {
    const existing = await selectSystemPlanByTypeAndName(db, plan.type, plan.name);
    if (existing) continue;

    try {
      await insertPlan(
        db,
        plan.name,
        plan.type,
        null,
        plan.monthlyAllowance,
        plan.maxUnitsPerRequest,
      );
      logger.info({ plan: plan.name, type: plan.type }, "Seeded system plan");
    } catch (err) {
      // uq_system_plans: a concurrent bootstrap inserted the same (type, name)
      // first; the seeded catalog is identical either way.
      const pgErr = unwrapQueryError(err) as { code?: string };
      if (pgErr.code !== "23505") throw err;
      logger.info({ plan: plan.name }, "System plan seeded concurrently; reusing");
    }
  }
}

// Default assignment for a fresh account: the predefined Starter system plan.
// Existing accounts keep whatever they already have (ensureDefaultAssignment
// no-ops when a current assignment exists). This replaces the old per-account
// custom "Default Plan" so new accounts land on the shared catalog instead of
// a private duplicate.
async function ensureDefaultAssignment(accountId: bigint): Promise<void> {
  const current = await selectCurrentAssignmentByAccount(db, accountId);

  if (current) {
    return;
  }

  const starter = await selectSystemPlanByTypeAndName(db, "account", "Starter");
  if (!starter) {
    throw new Error("Starter system plan missing; run system-plan seeding first");
  }

  await createAssignment(Number(accountId as unknown as number), {
    planId: Number(starter.id),
    effectiveFrom: getUtcMonthStart(),
  }, Number(accountId as unknown as number));
}

export async function bootstrap(): Promise<void> {
  getEnv();

  // System-plan seeding runs unconditionally (even without the env vars) so a
  // fresh install always has the predefined catalog regardless of whether an
  // account is bootstrapped.
  await ensureSystemPlans();

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
    try {
      const account = await insertAccount(db, bootstrapAccountName);
      accountId = account.id;
      logger.info({ accountId: accountId.toString() }, "Bootstrap account created");
    } catch (err) {
      // uq_accounts_name: a concurrent bootstrap inserted the same name first.
      const pgErr = unwrapQueryError(err) as { code?: string };
      if (pgErr.code !== "23505") throw err;
      const raced = await selectAccountByName(db, bootstrapAccountName);
      if (!raced) throw err;
      accountId = raced.id;
      logger.info({ accountId: accountId.toString() }, "Bootstrap account created concurrently; reusing");
    }
  }

  await ensureDefaultAssignment(accountId);

  const activeKey = await selectActiveApiKeyByName(db, accountId, bootstrapApiKeyName);
  const secretsDir = "/run/secrets";
  const secretPath = `${secretsDir}/api-key`;
  const canPersistSecret = fs.existsSync(secretsDir);

  if (activeKey) {
    if (!canPersistSecret || fs.existsSync(secretPath)) {
      // Key already provisioned: never mint a duplicate and never print a
      // secret again. (Locally there is no secrets volume, so nothing to
      // restore; the original secret is only where it was first written.)
      logger.info(
        { prefix: activeKey.prefix },
        "Bootstrap API key already exists; not re-printing the secret",
      );
      return;
    }
    // The secrets volume lost the file but the key row survives: the stored
    // hash cannot be reversed, so rotate to restore a usable secret file.
    // Order matters: write the replacement BEFORE revoking the old key so a
    // failed write can never strand the account with no usable key.
    const rotated = await createApiKey(Number(accountId as unknown as number), bootstrapApiKeyName);
    try {
      fs.writeFileSync(secretPath, rotated.key, { mode: 0o600 });
      fs.chmodSync(secretPath, 0o600);
    } catch (err) {
      // Write failed: keep the old key active (it is still the only usable
      // credential). Revoke the just-minted replacement so we do not leave an
      // extra active key we cannot show again, and fail loudly.
      await revokeApiKey(Number(accountId as unknown as number), Number(rotated.id));
      logger.error({ err }, "Failed to persist rotated bootstrap API key; old key kept active");
      throw err;
    }
    await revokeApiKey(Number(accountId as unknown as number), Number(activeKey.id));
    logger.info(
      { oldPrefix: activeKey.prefix, newPrefix: rotated.prefix },
      "Bootstrap API key file missing; rotated to a new key",
    );
    return;
  }

  const keyResult = await createApiKey(Number(accountId as unknown as number), bootstrapApiKeyName);
  logger.info({ prefix: keyResult.prefix }, "Bootstrap API key created");

  // Persist the bootstrapped key to the shared secrets volume so the client
  // container can pick it up. Skipped when /run/secrets is not available (e.g.
  // local development), where the key is shown on stdout. A write failure here
  // is non-fatal on first creation (the key is printed), but it is logged so
  // it is never silent.
  if (canPersistSecret) {
    try {
      fs.writeFileSync(secretPath, keyResult.key, { mode: 0o600 });
      fs.chmodSync(secretPath, 0o600);
    } catch (err) {
      logger.error(
        { err },
        "Failed to persist bootstrap API key to secrets volume; key printed to stdout only",
      );
    }
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
