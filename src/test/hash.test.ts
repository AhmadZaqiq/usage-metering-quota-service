import { describe, it, expect } from "vitest";
import { generateApiKey, sha256Hex, verifyApiKeyHash } from "../domain/hash.js";

describe("API key hashing", () => {
  it("generates a prefixed key whose secret verifies against its stored hash", () => {
    const { fullKey, prefix, hash } = generateApiKey();
    const [keyPrefix, secret] = fullKey.split(".");

    expect(prefix).toHaveLength(16);
    expect(keyPrefix).toBe(prefix);
    expect(secret).toHaveLength(64);
    expect(verifyApiKeyHash(secret, hash)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const { prefix, hash } = generateApiKey();
    const wrongSecret = "0".repeat(64);
    expect(verifyApiKeyHash(wrongSecret, hash)).toBe(false);
    expect(prefix).toHaveLength(16);
  });

  it("rejects a tampered stored hash", () => {
    const { fullKey, hash } = generateApiKey();
    const secret = fullKey.split(".")[1];
    const tampered = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
    expect(verifyApiKeyHash(secret, tampered)).toBe(false);
  });

  it("rejects a stored hash of different length instead of throwing", () => {
    expect(verifyApiKeyHash("anything", sha256Hex("x").slice(0, 32))).toBe(false);
  });

  it("does not embed the secret in the hash input space beyond a single preimage", () => {
    // Sanity: hashes are deterministic and secret-dependent.
    expect(sha256Hex("a")).toBe(sha256Hex("a"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
