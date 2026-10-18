import type { Transaction } from "../../db/client.js";
import { and, eq } from "drizzle-orm";
import { apiKeys, accounts } from "../../db/schema/index.js";

export interface ApiKeyRow {
  id: bigint;
  accountId: bigint;
  prefix: string;
  keyHash: string;
  name: string | null;
  isRevoked: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

function mapRowToApiKeyRow(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: row.id as bigint,
    accountId: row.accountId as bigint,
    prefix: row.prefix as string,
    keyHash: row.keyHash as string,
    name: row.name as string | null,
    isRevoked: row.isRevoked as boolean,
    createdAt: row.createdAt as Date,
    lastUsedAt: row.lastUsedAt as Date | null,
  };
}

export async function insertApiKey(
  tx: Transaction,
  accountId: bigint,
  prefix: string,
  keyHash: string,
  name: string | null,
): Promise<ApiKeyRow> {
  const result = await tx
    .insert(apiKeys)
    .values({
      accountId,
      prefix,
      keyHash,
      name,
    })
    .returning()
    .execute();

  return mapRowToApiKeyRow(result[0]);
}

export async function selectApiKeysByAccount(
  tx: Transaction,
  accountId: bigint,
): Promise<ApiKeyRow[]> {
  const result = await tx
    .select({
      id: apiKeys.id,
      accountId: apiKeys.accountId,
      prefix: apiKeys.prefix,
      keyHash: apiKeys.keyHash,
      name: apiKeys.name,
      isRevoked: apiKeys.isRevoked,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.accountId, accountId))
    .execute();

  return result.map(mapRowToApiKeyRow);
}

// Used by bootstrap to keep key creation idempotent across restarts: only an
// active (non-revoked) key counts as "already present".
export async function selectActiveApiKeyByName(
  tx: Transaction,
  accountId: bigint,
  name: string,
): Promise<ApiKeyRow | null> {
  const result = await tx
    .select({
      id: apiKeys.id,
      accountId: apiKeys.accountId,
      prefix: apiKeys.prefix,
      keyHash: apiKeys.keyHash,
      name: apiKeys.name,
      isRevoked: apiKeys.isRevoked,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.accountId, accountId), eq(apiKeys.name, name), eq(apiKeys.isRevoked, false)))
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToApiKeyRow(result[0]);
}

export async function updateApiKeyRevoked(
  tx: Transaction,
  keyId: bigint,
  accountId: bigint,
): Promise<{ rowCount: number }> {
  const result = await tx
    .update(apiKeys)
    .set({ isRevoked: true, revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId)))
    .execute();

  return { rowCount: Number(result.rowCount) };
}

export interface VerifiedApiKeyRecord {
  id: bigint;
  accountId: bigint;
  keyHash: string;
  isRevoked: boolean;
  accountIsActive: boolean;
  accountDeletedAt: Date | null;
}

export async function findApiKeyByPrefix(
  tx: Transaction,
  prefix: string,
): Promise<VerifiedApiKeyRecord | null> {
  const result = await tx
    .select({
      id: apiKeys.id,
      accountId: apiKeys.accountId,
      keyHash: apiKeys.keyHash,
      isRevoked: apiKeys.isRevoked,
      accountIsActive: accounts.isActive,
      accountDeletedAt: accounts.deletedAt,
    })
    .from(apiKeys)
    .innerJoin(accounts, eq(apiKeys.accountId, accounts.id))
    .where(and(eq(apiKeys.prefix, prefix), eq(apiKeys.isRevoked, false)))
    .limit(1)
    .execute();

  if (result.length === 0) return null;

  const record = result[0];
  return {
    id: record.id,
    accountId: record.accountId,
    keyHash: record.keyHash,
    isRevoked: record.isRevoked,
    accountIsActive: record.accountIsActive,
    accountDeletedAt: record.accountDeletedAt,
  };
}

export async function updateApiKeyLastUsedAt(
  tx: Transaction,
  keyId: bigint,
): Promise<void> {
  await tx
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, keyId))
    .execute();
}
