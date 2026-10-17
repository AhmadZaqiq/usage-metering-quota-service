import { db } from "../../db/client.js";
import {
  insertApiKey,
  selectApiKeysByAccount,
  updateApiKeyRevoked,
} from "./apiKeyRepository.js";
import { generateApiKey } from "../../utils/hash.js";
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

  const key = await insertApiKey(db, BigInt(accountId), prefix, hash, name ?? null);

  return {
    id: Number(key.id),
    prefix: key.prefix,
    key: fullKey,
    name: key.name ?? null,
  };
}

export async function listApiKeys(accountId: number): Promise<ApiKeyInfo[]> {
  const keys = await selectApiKeysByAccount(db, BigInt(accountId));

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
  const result = await updateApiKeyRevoked(db, BigInt(keyId), BigInt(accountId));

  if (result.rowCount === 0) {
    throw new NotFoundError("API key not found");
  }
}
