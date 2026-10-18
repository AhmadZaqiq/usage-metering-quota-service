import { describe, it, expect, vi, afterEach } from "vitest";

// Environment parsing is cached per module instance, so each case starts from
// a fresh module registry with an explicitly constructed process.env.
const baseEnv = { ...process.env };

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...baseEnv };
  delete process.env.TRUST_PROXY;
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return import("../config/index.js");
}

afterEach(() => {
  process.env = { ...baseEnv };
  vi.resetModules();
});

describe("TRUST_PROXY environment parsing", () => {
  it("defaults to false when unset", async () => {
    const config = await loadEnv({});
    expect(config.getEnv().TRUST_PROXY).toBe(false);
  });

  it('parses "true" as true', async () => {
    const config = await loadEnv({ TRUST_PROXY: "true" });
    expect(config.getEnv().TRUST_PROXY).toBe(true);
  });

  it('parses "false" as false (not truthy-by-presence like Boolean("false"))', async () => {
    const config = await loadEnv({ TRUST_PROXY: "false" });
    expect(config.getEnv().TRUST_PROXY).toBe(false);
  });

  it.each(["1", "yes", "TRUE", "False", "", "on"])(
    "rejects invalid value %j instead of coercing it",
    async (value) => {
      // config/index.ts validates at import time (fail-fast at startup).
      await expect(loadEnv({ TRUST_PROXY: value })).rejects.toThrow(/TRUST_PROXY/);
    },
  );

  it("fails fast with a descriptive configuration error", async () => {
    await expect(loadEnv({ TRUST_PROXY: "1" })).rejects.toThrow(
      "Invalid environment configuration",
    );
  });
});

describe("other environment boundaries", () => {
  it("requires DATABASE_URL", async () => {
    await expect(loadEnv({ DATABASE_URL: undefined })).rejects.toThrow(/DATABASE_URL/);
  });

  it("coerces RATE_LIMIT_MAX from string to number", async () => {
    const config = await loadEnv({ RATE_LIMIT_MAX: "42" });
    expect(config.getEnv().RATE_LIMIT_MAX).toBe(42);
  });
});
