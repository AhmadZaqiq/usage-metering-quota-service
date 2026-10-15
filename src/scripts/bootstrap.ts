import { db } from "../db/client.js";
import { accounts, apiKeys } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { createApiKey } from "../modules/auth/apiKeyService.js";
import { getEnv } from "../config/index.js";
import { logger } from "../logging/logger.js";

async function main() {
  const env = getEnv();

  if (!env.BOOTSTRAP_ACCOUNT_NAME || !env.BOOTSTRAP_API_KEY_NAME) {
    logger.info("Bootstrap skipped: BOOTSTRAP_ACCOUNT_NAME and BOOTSTRAP_API_KEY_NAME not set");
    return;
  }

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

  const keyResult = await createApiKey(Number(accountId), env.BOOTSTRAP_API_KEY_NAME);
  logger.info({ prefix: keyResult.prefix, key: keyResult.key }, "Bootstrap API key created");
  console.log("\n=== BOOTSTRAP API KEY (save this - shown only once) ===");
  console.log(keyResult.key);
  console.log("========================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Bootstrap failed");
    process.exit(1);
  });