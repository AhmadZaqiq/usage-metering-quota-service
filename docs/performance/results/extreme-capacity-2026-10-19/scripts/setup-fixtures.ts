// Create isolated campaign fixtures (accounts, custom plans, assignments,
// users, API keys) directly through the application services, exactly like
// src/scripts/bootstrap-loadtest.ts does. Campaign-only tool (untracked).
//
// SAFETY: refuses to run unless DATABASE_URL targets the isolated campaign
// Postgres on port 5440. This tool never touches the development database.
//
// Usage:
//   DATABASE_URL=postgresql://app:app_secret@localhost:5440/usage_metering \
//     npx tsx scripts/setup-fixtures.ts --config scripts/fixtures.json \
//     --out snapshots/fixtures-output.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { db, closePool } from "../../../../../src/db/client.js";
import {
  insertAccount,
  selectAccountByName,
} from "../../../../../src/infrastructure/repositories/accountRepository.js";
import { selectPlanByAccountAndName } from "../../../../../src/infrastructure/repositories/planRepository.js";
import {
  deleteAssignmentsByAccount,
} from "../../../../../src/infrastructure/repositories/assignmentRepository.js";
import {
  insertUser,
  selectUserByAccountAndClientUserId,
} from "../../../../../src/infrastructure/repositories/userRepository.js";
import { createApiKey, revokeApiKey } from "../../../../../src/application/auth/apiKeyService.js";
import { selectActiveApiKeyByName } from "../../../../../src/infrastructure/repositories/apiKeyRepository.js";
import { createAssignment } from "../../../../../src/application/plans/assignmentService.js";
import { createPlan } from "../../../../../src/application/plans/planService.js";
import { getUtcMonthStart } from "../../../../../src/domain/date.js";

interface AccountFixture {
  name: string;
  keyName: string;
  accountAllowance: string;
  userAllowance: string;
  maxUnitsPerRequest?: string;
  users: string[];
}

interface FixturesFile {
  accounts: AccountFixture[];
}

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "scripts/fixtures.json" },
    out: { type: "string" },
  },
  strict: true,
});

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!/:5440\//.test(databaseUrl)) {
  console.error(
    `REFUSING TO RUN: DATABASE_URL does not target the isolated campaign database (port 5440).\n` +
      `Got: ${databaseUrl.replace(/:[^:@/]+@/, ":***@")}`
  );
  process.exit(2);
}

const fixtures = JSON.parse(readFileSync(resolve(values.config), "utf8")) as FixturesFile;
const effectiveFrom = getUtcMonthStart();
const output: Record<string, unknown> = {};

async function ensureAccount(name: string): Promise<bigint> {
  const existing = await selectAccountByName(db, name);
  if (existing) {
    console.log(`account ${name}: reuse id=${existing.id}`);
    return existing.id;
  }
  const created = await insertAccount(db, name);
  console.log(`account ${name}: created id=${created.id}`);
  return created.id;
}

async function ensurePlan(
  accountId: bigint,
  accountName: string,
  type: "account" | "user",
  monthlyAllowance: bigint,
  maxUnitsPerRequest: bigint
): Promise<number> {
  const planName = type === "account" ? `${accountName} account plan` : `${accountName} user plan`;
  const existing = await selectPlanByAccountAndName(db, accountId, planName);
  if (existing) {
    console.log(`plan ${planName}: reuse id=${existing.id}`);
    return Number(existing.id);
  }
  const plan = await createPlan(
    { name: planName, type, monthlyAllowance, maxUnitsPerRequest },
    Number(accountId)
  );
  console.log(`plan ${planName}: created id=${plan.id}`);
  return Number(plan.id);
}

async function ensureUser(accountId: bigint, clientUserId: string): Promise<bigint> {
  const existing = await selectUserByAccountAndClientUserId(db, accountId, clientUserId);
  if (existing) return existing.id;
  const created = await insertUser(db, accountId, clientUserId);
  return created.id;
}

async function main(): Promise<void> {
  for (const fixture of fixtures.accounts) {
    const maxUnitsPerRequest = BigInt(fixture.maxUnitsPerRequest ?? "10000");
    const accountId = await ensureAccount(fixture.name);
    const accountPlanId = await ensurePlan(
      accountId,
      fixture.name,
      "account",
      BigInt(fixture.accountAllowance),
      maxUnitsPerRequest
    );
    const userPlanId = await ensurePlan(
      accountId,
      fixture.name,
      "user",
      BigInt(fixture.userAllowance),
      maxUnitsPerRequest
    );

    // Rebuild account-level assignment from scratch (isolated DB only), then
    // ensure every user has a current user-plan assignment.
    await deleteAssignmentsByAccount(db, accountId);
    await createAssignment(
      Number(accountId),
      { planId: accountPlanId, effectiveFrom },
      Number(accountId)
    );

    const userIds: Record<string, string> = {};
    for (const clientUserId of fixture.users) {
      const userId = await ensureUser(accountId, clientUserId);
      userIds[clientUserId] = userId.toString();
      await createAssignment(
        Number(accountId),
        { userId: clientUserId, planId: userPlanId, effectiveFrom },
        Number(accountId)
      );
    }

    // Rotate the load key on every setup run so reruns always get a usable
    // secret (the full secret is shown only once at creation).
    const activeKey = await selectActiveApiKeyByName(db, accountId, fixture.keyName);
    if (activeKey) {
      await revokeApiKey(Number(accountId), Number(activeKey.id));
    }
    const keyResult = await createApiKey(Number(accountId), fixture.keyName);

    output[fixture.name] = {
      accountId: accountId.toString(),
      accountPlanId,
      userPlanId,
      accountAllowance: fixture.accountAllowance,
      userAllowance: fixture.userAllowance,
      maxUnitsPerRequest: maxUnitsPerRequest.toString(),
      users: userIds,
      apiKey: keyResult.key,
      keyPrefix: keyResult.prefix,
      keyId: keyResult.id,
    };
    console.log(
      `account ${fixture.name}: ready (id=${accountId}, users=${fixture.users.length}, key=${keyResult.prefix})`
    );
  }

  const json = JSON.stringify(output, null, 2);
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, json);
    console.log(`fixtures written to ${values.out} (contains ephemeral test secrets)`);
  }
  console.log("=== FIXTURES COMPLETE ===");
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("fixtures setup failed:", err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
