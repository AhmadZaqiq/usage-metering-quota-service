import { createHash, randomBytes } from "crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function generateApiKey(): { fullKey: string; prefix: string; hash: string } {
  const prefix = randomBytes(8).toString("hex"); // 16 chars
  const secret = randomBytes(32).toString("hex"); // 64 chars
  const fullKey = `${prefix}.${secret}`;
  const hash = sha256Hex(secret);
  return { fullKey, prefix, hash };
}

export function verifyApiKeyHash(secret: string, expectedHash: string): boolean {
  const hash = sha256Hex(secret);
  return hash === expectedHash;
}