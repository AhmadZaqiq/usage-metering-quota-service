import { Redis as RedisClient } from "ioredis";
import { Request, Response, NextFunction } from "express";
import { getEnv } from "../config/index.js";
import { logger } from "../logging/logger.js";

interface RateLimitInfo {
  total: number;
  remaining: number;
  resetTime: number;
}

export interface RateLimiterStore {
  increment(key: string, windowMs: number): Promise<RateLimitInfo>;
  reset(key: string): Promise<void>;
  close(): Promise<void>;
}

class MemoryStore implements RateLimiterStore {
  private hits = new Map<string, { count: number; resetTime: number }>();

  async increment(key: string, windowMs: number): Promise<RateLimitInfo> {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now > entry.resetTime) {
      const resetTime = now + windowMs;
      this.hits.set(key, { count: 1, resetTime });
      return { total: 1, remaining: 0, resetTime };
    }

    entry.count++;
    return { total: entry.count, remaining: Math.max(0, entry.count - 1), resetTime: entry.resetTime };
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }

  async close(): Promise<void> {
    this.hits.clear();
  }
}

class RedisStore implements RateLimiterStore {
  private client: RedisClient;
  private keyPrefix: string;

  constructor(redisUrl: string, keyPrefix = "ratelimit:") {
    this.client = new RedisClient(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 100, 3000);
      },
      lazyConnect: true,
    });
    this.keyPrefix = keyPrefix;

    this.client.on("error", (err: Error) => {
      logger.error({ err }, "Redis rate limiter connection error");
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async increment(key: string, windowMs: number): Promise<RateLimitInfo> {
    const fullKey = `${this.keyPrefix}${key}`;
    const windowSec = Math.ceil(windowMs / 1000);
    const now = Math.floor(Date.now() / 1000);
    const resetTime = (now + windowSec) * 1000;

    const multi = this.client.multi();
    multi.incr(fullKey);
    multi.expire(fullKey, windowSec, "NX");
    const results = await multi.exec();

    if (!results) {
      throw new Error("Redis multi exec returned null");
    }

    const total = results[0][1] as number;
    const remaining = Math.max(0, total - 1);

    return { total, remaining, resetTime };
  }

  async reset(key: string): Promise<void> {
    const fullKey = `${this.keyPrefix}${key}`;
    await this.client.del(fullKey);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

let storeInstance: RateLimiterStore | null = null;

export function getRateLimiterStore(): RateLimiterStore {
  if (storeInstance) return storeInstance;

  const env = getEnv();

  if (env.REDIS_URL) {
    const store = new RedisStore(env.REDIS_URL);
    store.connect().catch((err: Error) => {
      logger.error({ err }, "Failed to connect to Redis for rate limiting, falling back to memory store");
      storeInstance = new MemoryStore();
    });
    storeInstance = store;
  } else {
    storeInstance = new MemoryStore();
  }

  return storeInstance;
}

export function createRateLimiterMiddleware() {
  const store = getRateLimiterStore();
  const env = getEnv();

  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    let key: string;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const fullKey = authHeader.slice(7);
      const prefix = fullKey.split(".")[0];
      key = `key:${prefix}`;
    } else {
      key = `ip:${req.ip}`;
    }

    try {
      const info = await store.increment(key, env.RATE_LIMIT_WINDOW_MS);

      res.setHeader("X-RateLimit-Limit", env.RATE_LIMIT_MAX.toString());
      res.setHeader("X-RateLimit-Remaining", info.remaining.toString());
      res.setHeader("X-RateLimit-Reset", Math.ceil(info.resetTime / 1000).toString());

      if (info.total > env.RATE_LIMIT_MAX) {
        return res.status(429).json({
          error: { code: "RATE_LIMITED", message: "Too many requests" },
        });
      }

      next();
    } catch (err) {
      logger.error({ err, key }, "Rate limiter error, allowing request");
      next();
    }
  };
}

export async function closeRateLimiterStore(): Promise<void> {
  if (storeInstance) {
    await storeInstance.close();
    storeInstance = null;
  }
}