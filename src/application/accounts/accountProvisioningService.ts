import { withTransaction } from "../../db/client.js";
import {
  selectAccountByName,
  insertAccount,
} from "../../infrastructure/repositories/accountRepository.js";
import { selectSystemPlanByTypeAndName } from "../../infrastructure/repositories/planRepository.js";
import {
  insertApiKey,
} from "../../infrastructure/repositories/apiKeyRepository.js";
import { insertAssignment } from "../../infrastructure/repositories/assignmentRepository.js";
import { generateApiKey } from "../../domain/hash.js";
import { getUtcMonthStart } from "../../domain/date.js";
import { ConflictError, InternalError } from "../../errors/AppError.js";
import { unwrapQueryError } from "../../domain/pgError.js";

export interface ProvisionAccountInput {
  name: string;
  apiKeyName?: string;
}

export interface ProvisionAccountResult {
  account: {
    id: number;
    name: string;
    createdAt: Date;
  };
  apiKey: {
    id: number;
    prefix: string;
    name: string | null;
    key: string;
  };
}

/**
 * Create an account, its default Starter plan assignment, and its first API
 * key in one transaction: either all three exist or none do. The plaintext
 * key is returned exactly once; only its SHA-256 hash is stored. The
 * duplicate-name race (uq_accounts_name) is reported as a 409 conflict, and
 * the default assignment requires the seeded Starter system plan (bootstrap
 * always seeds it before the app serves traffic in the compose stack).
 */
export async function provisionAccount(
  input: ProvisionAccountInput,
): Promise<ProvisionAccountResult> {
  const { fullKey, prefix, hash } = generateApiKey();
  const keyName = input.apiKeyName ?? "Default Key";

  return await withTransaction(async (tx) => {
    const existing = await selectAccountByName(tx, input.name);
    if (existing) {
      throw new ConflictError("Account name already exists");
    }

    let account;
    try {
      account = await insertAccount(tx, input.name);
    } catch (err) {
      const pgCode = (unwrapQueryError(err) as { code?: string }).code;
      if (pgCode === "23505") {
        // uq_accounts_name: a concurrent provisioning attempt won the race.
        throw new ConflictError("Account name already exists");
      }
      throw err;
    }

    const starter = await selectSystemPlanByTypeAndName(tx, "account", "Starter");
    if (!starter) {
      throw new InternalError("Starter system plan missing; run bootstrap first");
    }

    // First (immediate) account-level assignment, stamped with the UTC month
    // start like the bootstrap default assignment.
    await insertAssignment(tx, account.id, null, starter.id, getUtcMonthStart(), null);

    const keyRow = await insertApiKey(tx, account.id, prefix, hash, keyName);

    return {
      account: {
        id: Number(account.id),
        name: account.name,
        createdAt: account.createdAt,
      },
      apiKey: {
        id: Number(keyRow.id),
        prefix: keyRow.prefix,
        name: keyRow.name ?? null,
        key: fullKey,
      },
    };
  });
}
