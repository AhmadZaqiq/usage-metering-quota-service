import { sql } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";
import { and, eq } from "drizzle-orm";
import { apiKeys } from "../../db/schema/index.js";

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
  const result = await tx.execute(sql`
    SELECT api_keys.id as id, api_keys.account_id as "accountId", api_keys.key_hash as "keyHash",
           api_keys.is_revoked as "isRevoked", accounts.is_active as "accountIsActive",
           accounts.deleted_at as "accountDeletedAt"
    FROM api_keys
    INNER JOIN accounts ON api_keys.account_id = accounts.id
    WHERE api_keys.prefix = ${prefix} AND api_keys.is_revoked = false
    LIMIT 1
  `);

  if (result.rows.length === 0) return null;

  const record = result.rows[0];
  return {
    id: record.id as bigint,
    accountId: record.accountId as bigint,
    keyHash: record.keyHash as string,
    isRevoked: record.isRevoked as boolean,
    accountIsActive: record.accountIsActive as boolean,
    accountDeletedAt: record.accountDeletedAt as Date | null,
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
