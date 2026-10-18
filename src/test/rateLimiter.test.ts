import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import type { Request, Response } from "express";

// Behavioral tests for the two-layer rate limiter. They intentionally assert
// *policy*, not implementation details:
//   - pre-auth layer is keyed by IP only (an unverified Bearer prefix must not
//     mint a fresh bucket per request),
//   - post-auth layer is keyed by the verified API-key identity,
//   - a failing store falls back to the bounded in-process store and still
//     enforces limits (never fail open),
//   - a total store failure fails closed with 429.

const baseEnv = { ...process.env };

vi.mock("ioredis", () => ({
  Redis: class {
    on(): void {}
    async connect(): Promise<never> {
      throw new Error("connection refused (test double)");
    }
    async quit(): Promise<void> {}
  },
}));

interface RateLimiterModule {
  createIpRateLimiterMiddleware: () => (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
  createIdentityRateLimiterMiddleware: () => (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
  MemoryStore: new () => {
    increment(key: string, windowMs: number): Promise<{ total: number; remaining: number; resetTime: number }>;
    size: number;
  };
}

let rl: RateLimiterModule;

async function loadRateLimiter(vars: Record<string, string | undefined>): Promise<RateLimiterModule> {
  vi.resetModules();
  process.env = { ...baseEnv };
  delete process.env.REDIS_URL;
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
  it("fails closed (429) when even the in-process store throws", async () => {
    const middleware = rl.createIpRateLimiterMiddleware();
    // Reject every increment, including the internal fallback attempt: the
    // only remaining policy is to refuse the request, never to allow it.
    const spy = vi
      .spyOn(rl.MemoryStore.prototype, "increment")
      .mockRejectedValue(new Error("memory store failure"));

    const res = makeRes();
    const { passed } = await runMiddleware(middleware, makeReq({ ip: "10.6.0.1" }), res);

    expect(spy).toHaveBeenCalled();
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it("falls back to the in-process store when Redis is configured but unreachable, and still enforces the limit", async () => {
    rl = await loadRateLimiter({ REDIS_URL: "redis://127.0.0.1:6390", RATE_LIMIT_MAX: "3" });
    const middleware = rl.createIpRateLimiterMiddleware();

    // Give the (failing) Redis connection attempt a moment to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (let i = 0; i < 3; i++) {
      const { passed } = await runMiddleware(middleware, makeReq({ ip: "10.7.0.1" }), makeRes());
      expect(passed).toBe(true);
    }

    const res = makeRes();
    const { passed } = await runMiddleware(middleware, makeReq({ ip: "10.7.0.1" }), res);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
  });
});

describe("MemoryStore bounds and windows", () => {
  it("never grows beyond the configured entry bound", async () => {
    const store = new rl.MemoryStore();
    for (let i = 0; i < 10_050; i++) {
      await store.increment(`fill:${i}`, 60_000);
    }
    expect(store.size).toBeLessThanOrEqual(10_000);
    expect(store.size).toBeGreaterThan(0);
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
});
