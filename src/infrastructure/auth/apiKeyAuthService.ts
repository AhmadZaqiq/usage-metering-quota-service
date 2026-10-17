import { db } from "../../db/client.js";
import { findApiKeyByPrefix } from "../repositories/apiKeyRepository.js";
import { verifyApiKeyHash } from "../../domain/hash.js";

export interface VerifiedApiKey {
  accountId: number;
  apiKeyId: number;
}

export async function verifyApiKey(fullKey: string): Promise<VerifiedApiKey | null> {
  const parts = fullKey.split(".");
  if (parts.length !== 2) return null;

  const [prefix, secret] = parts;
  if (!prefix || !secret) return null;

  const key = await findApiKeyByPrefix(db, prefix);

  if (!key) return null;

  if (!key.accountIsActive || key.accountDeletedAt) return null;

  if (!verifyApiKeyHash(secret, key.keyHash)) return null;

  return {
    accountId: Number(key.accountId),
    apiKeyId: Number(key.id),
  };
}
