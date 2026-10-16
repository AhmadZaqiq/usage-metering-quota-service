import { db } from "../../db/client.js";
import { apiKeys, accounts } from "../../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { generateApiKey, verifyApiKeyHash } from "../../utils/hash.js";
import { NotFoundError } from "../../errors/AppError.js";

export interface ApiKeyInfo {
  id: number;
  prefix: string;
  name: string | null;
  isRevoked: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateApiKeyResult {
  id: number;
  prefix: string;
  key: string;
  name: string | null;
}

export async function createApiKey(accountId: number, name?: string): Promise<CreateApiKeyResult> {
  const { fullKey, prefix, hash } = generateApiKey();

  const [key] = await db
    .insert(apiKeys)
    .values({
      accountId: BigInt(accountId),
      prefix,
      keyHash: hash,
      name: name ?? null,
    })
    .returning({ id: apiKeys.id, prefix: apiKeys.prefix, name: apiKeys.name })
    .execute();

  // key is guaranteed to exist since insert succeeded
  return {
    id: Number(key.id),
    prefix: key.prefix,
    key: fullKey,
    name: key.name ?? null,
  };
}

export async function listApiKeys(accountId: number): Promise<ApiKeyInfo[]> {
  const keys = await db
    .select({
      id: apiKeys.id,
      prefix: apiKeys.prefix,
      name: apiKeys.name,
      isRevoked: apiKeys.isRevoked,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.accountId, BigInt(accountId)))
    .execute();

  return keys.map((k) => ({
    id: Number(k.id),
    prefix: k.prefix,
    name: k.name,
    isRevoked: k.isRevoked,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
  }));
}

export async function revokeApiKey(accountId: number, keyId: number): Promise<void> {
  const result = await db
    .update(apiKeys)
    .set({ isRevoked: true, revokedAt: new Date() })
    .where(and(eq(apiKeys.id, BigInt(keyId)), eq(apiKeys.accountId, BigInt(accountId))))
    .execute();

  if (result.rowCount === 0) {
    throw new NotFoundError("API key not found");
  }
}

export interface VerifiedApiKey {
  accountId: number;
  apiKeyId: number;
}

export async function verifyApiKey(fullKey: string): Promise<VerifiedApiKey | null> {
  const parts = fullKey.split(".");
  if (parts.length !== 2) return null;

  const [prefix, secret] = parts;
  if (!prefix || !secret) return null;

  const key = await db
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

  if (key.length === 0) return null;

  const record = key[0];

  if (!record.accountIsActive || record.accountDeletedAt) return null;

  if (!verifyApiKeyHash(secret, record.keyHash)) return null;

  return {
    accountId: Number(record.accountId),
    apiKeyId: Number(record.id),
  };
}