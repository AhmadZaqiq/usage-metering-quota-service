import { createHash, randomBytes, timingSafeEqual } from "crypto";

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

// Constant-time comparison: both values are SHA-256 hex digests (64 chars).
// The length guard keeps the function total for malformed stored hashes.
export function verifyApiKeyHash(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256Hex(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}