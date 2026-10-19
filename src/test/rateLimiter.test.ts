import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import type { Request, Response } from "express";

// Behavioral tests for the two-layer, in-process rate limiter. They
// intentionally assert *policy*, not implementation details:
//   - pre-auth layer is keyed by IP only (an unverified Bearer prefix must not
//     mint a fresh bucket per request),
//   - post-auth layer is keyed by the verified API-key identity,
//   - concurrent requests within one process cannot bypass the limit
//     (synchronous counter updates),
//   - a store failure fails closed with 429 (never fail open),
//   - counters are per process: a new store starts empty (documented
//     restart / multi-replica limitation).
//
// The limiter has no external backend; every test runs against the
// bounded in-process MemoryStore.

const baseEnv = { ...process.env };

interface RateLimiterModule {
  createIpRateLimiterMiddleware: () => (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
  createIdentityRateLimiterMiddleware: () => (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
  MemoryStore: new () => {
    increment(key: string, windowMs: number): Promise<{ total: number; remaining: number; resetTime: number }>;
    reset(key: string): Promise<void>;
    size: number;
  };
}

let rl: RateLimiterModule;

async function loadRateLimiter(vars: Record<string, string | undefined>): Promise<RateLimiterModule> {
  vi.resetModules();
  process.env = { ...baseEnv };
  process.env.RATE_LIMIT_MAX = "5";
  process.env.RATE_LIMIT_WINDOW_MS = "60000";
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return import("../infrastructure/rateLimiter.js") as Promise<RateLimiterModule>;
}

interface FakeReq {
  ip: string;
  headers: Record<string, string>;
  apiKeyId?: number;
}

function makeReq(overrides: Partial<FakeReq> = {}): FakeReq {
  return { ip: "10.1.1.1", headers: {}, ...overrides };
}

interface FakeRes {
  headers: Record<string, string>;
  statusCode: number | null;
  body: unknown;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) {
      res.headers[name] = value;
    },
    getHeader(name) {
      return res.headers[name];
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

async function runMiddleware(
  middleware: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>,
  req: FakeReq,
  res: FakeRes,
): Promise<{ passed: boolean }> {
  let passed = false;
  await middleware(req as unknown as Request, res as unknown as Response, () => {
    passed = true;
  });
  return { passed };
}

beforeAll(async () => {
  rl = await loadRateLimiter({});
});

afterEach(() => {
  process.env = { ...baseEnv };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("IP layer (pre-authentication)", () => {
  it("allows up to RATE_LIMIT_MAX requests, then returns 429 with rate-limit headers", async () => {
    const middleware = rl.createIpRateLimiterMiddleware();

    for (let i = 1; i <= 5; i++) {
      const res = makeRes();
      const { passed } = await runMiddleware(middleware, makeReq({ ip: "10.2.0.1" }), res);
      expect(passed).toBe(true);
      expect(res.headers["X-RateLimit-Limit"]).toBe("5");
      expect(res.headers["X-RateLimit-Remaining"]).toBe(String(5 - i));
      expect(Number(res.headers["X-RateLimit-Reset"])).toBeGreaterThan(0);
    }

    const res = makeRes();
    const { passed } = await runMiddleware(middleware, makeReq({ ip: "10.2.0.1" }), res);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
    expect(res.headers["X-RateLimit-Remaining"]).toBe("0");
  });

  it("isolates buckets per IP address", async () => {
    const middleware = rl.createIpRateLimiterMiddleware();

    for (let i = 0; i < 5; i++) {
      const { passed } = await runMiddleware(middleware, makeReq({ ip: "10.2.0.2" }), makeRes());
      expect(passed).toBe(true);
    }

    const { passed: blocked } = await runMiddleware(middleware, makeReq({ ip: "10.2.0.2" }), makeRes());
    expect(blocked).toBe(false);

    const { passed: otherIp } = await runMiddleware(middleware, makeReq({ ip: "10.2.0.3" }), makeRes());
    expect(otherIp).toBe(true);
  });

  it("does not mint a new bucket per unverified Bearer token", async () => {
    const middleware = rl.createIpRateLimiterMiddleware();

    // An attacker rotating garbage Authorization headers stays in one IP bucket.
    for (let i = 0; i < 5; i++) {
      const { passed } = await runMiddleware(
        middleware,
        makeReq({ ip: "10.2.0.4", headers: { authorization: `Bearer garbage-${i}` } }),
        makeRes(),
      );
      expect(passed).toBe(true);
    }

    const res = makeRes();
    const { passed } = await runMiddleware(
      middleware,
      makeReq({ ip: "10.2.0.4", headers: { authorization: "Bearer garbage-final" } }),
      res,
    );
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it("enforces the limit under concurrent requests within one process", async () => {
    const middleware = rl.createIpRateLimiterMiddleware();

    // Fire all requests "at once": the synchronous counter updates must not
    // lose counts, so exactly RATE_LIMIT_MAX pass and the rest are rejected.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => {
        const res = makeRes();
        return runMiddleware(middleware, makeReq({ ip: "10.2.0.5" }), res).then((r) => ({ ...r, res }));
      }),
    );

    const passedCount = results.filter((r) => r.passed).length;
    const rejectedCount = results.filter((r) => !r.passed).length;
    expect(passedCount).toBe(5);
    expect(rejectedCount).toBe(7);
    for (const r of results.filter((x) => !x.passed)) {
      expect(r.res.statusCode).toBe(429);
    }
  });
});

describe("Identity layer (post-authentication)", () => {
  it("keys by verified API-key id and isolates tenants", async () => {
    const middleware = rl.createIdentityRateLimiterMiddleware();

    for (let i = 0; i < 5; i++) {
      const { passed } = await runMiddleware(
        middleware,
        makeReq({ ip: "10.3.0.1", apiKeyId: 701 }),
        makeRes(),
      );
      expect(passed).toBe(true);
    }

    const exhausted = makeRes();
    const { passed: blocked } = await runMiddleware(
      middleware,
      makeReq({ ip: "10.3.0.1", apiKeyId: 701 }),
      exhausted,
    );
    expect(blocked).toBe(false);
    expect(exhausted.statusCode).toBe(429);

    // A different tenant is unaffected.
    const { passed: otherTenant } = await runMiddleware(
      middleware,
      makeReq({ ip: "10.3.0.1", apiKeyId: 702 }),
      makeRes(),
    );
    expect(otherTenant).toBe(true);
  });

  it("shares one bucket per identity across different client IPs", async () => {
    const middleware = rl.createIdentityRateLimiterMiddleware();

    for (let i = 0; i < 3; i++) {
      const { passed } = await runMiddleware(
        middleware,
        makeReq({ ip: `10.4.0.${i + 1}`, apiKeyId: 703 }),
        makeRes(),
      );
      expect(passed).toBe(true);
    }
    for (let i = 0; i < 2; i++) {
      const { passed } = await runMiddleware(
        middleware,
        makeReq({ ip: `10.4.1.${i + 1}`, apiKeyId: 703 }),
        makeRes(),
      );
      expect(passed).toBe(true);
    }

    const { passed: blocked } = await runMiddleware(
      middleware,
      makeReq({ ip: "10.4.2.1", apiKeyId: 703 }),
      makeRes(),
    );
    expect(blocked).toBe(false);
  });

  it("falls back to the IP key when no identity is attached", async () => {
    const middleware = rl.createIdentityRateLimiterMiddleware();

    for (let i = 0; i < 5; i++) {
      const { passed } = await runMiddleware(middleware, makeReq({ ip: "10.5.0.1" }), makeRes());
      expect(passed).toBe(true);
    }
    const { passed: blocked } = await runMiddleware(middleware, makeReq({ ip: "10.5.0.1" }), makeRes());
    expect(blocked).toBe(false);
  });
});

describe("failure policy", () => {
  it("fails closed (429) when the store throws", async () => {
    const middleware = rl.createIpRateLimiterMiddleware();
    // The only remaining policy when the store itself fails is to refuse the
    // request, never to allow it (fail closed, no Retry-After on this path).
    const spy = vi
      .spyOn(rl.MemoryStore.prototype, "increment")
      .mockRejectedValue(new Error("memory store failure"));

    const res = makeRes();
    const { passed } = await runMiddleware(middleware, makeReq({ ip: "10.6.0.1" }), res);

    expect(spy).toHaveBeenCalled();
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeUndefined();
  });
});

describe("MemoryStore bounds, windows, and process locality", () => {
  it("never grows beyond the configured entry bound", async () => {
    const store = new rl.MemoryStore();
    for (let i = 0; i < 10_050; i++) {
      await store.increment(`fill:${i}`, 60_000);
    }
    expect(store.size).toBeLessThanOrEqual(10_000);
    expect(store.size).toBeGreaterThan(0);
  });

  it("reclaims expired entries when at capacity instead of growing without bound", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
      const store = new rl.MemoryStore();

      // Fill the store to its bound with a short window.
      for (let i = 0; i < 10_000; i++) {
        await store.increment(`reclaim:${i}`, 1_000);
      }
      expect(store.size).toBe(10_000);

      // After the window expires, inserting new keys must evict the stale
      // entries rather than exceed the bound.
      vi.setSystemTime(new Date("2026-10-18T00:00:02Z"));
      for (let i = 0; i < 10; i++) {
        await store.increment(`fresh:${i}`, 1_000);
      }
      expect(store.size).toBeLessThanOrEqual(10_000);
      // The fresh keys are present.
      const probe = await store.increment("fresh:0", 1_000);
      expect(probe.total).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh window after resetTime elapses", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
      const store = new rl.MemoryStore();

      const first = await store.increment("windowed", 1_000);
      expect(first.total).toBe(1);

      const second = await store.increment("windowed", 1_000);
      expect(second.total).toBe(2);

      vi.setSystemTime(new Date("2026-10-18T00:00:02Z"));
      const afterExpiry = await store.increment("windowed", 1_000);
      expect(afterExpiry.total).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist counters across a store restart (documented limitation)", async () => {
    const before = new rl.MemoryStore();
    await before.increment("restart", 60_000);
    await before.increment("restart", 60_000);
    await before.increment("restart", 60_000);
    expect(before.size).toBe(1);

    // A new store instance models a process restart: counters are gone.
    const after = new rl.MemoryStore();
    const fresh = await after.increment("restart", 60_000);
    expect(fresh.total).toBe(1);
    expect(after.size).toBe(1);
  });
});
