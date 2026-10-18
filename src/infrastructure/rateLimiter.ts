import { Redis as RedisClient } from 'ioredis';
import { Request, Response, NextFunction } from 'express';
import { getEnv } from '../config/index.js';
import { logger } from '../logging/logger.js';

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

// Bounds the in-memory fallback so attacker-controlled key cardinality
// (many distinct IPs) cannot grow the map without limit.
const MEMORY_STORE_MAX_ENTRIES = 10_000;

export class MemoryStore implements RateLimiterStore {
  private hits = new Map<string, { count: number; resetTime: number }>();

  increment(key: string, windowMs: number): Promise<RateLimitInfo> {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (entry && now <= entry.resetTime) {
      entry.count++;
      return Promise.resolve({
        total: entry.count,
        remaining: Math.max(0, entry.count - 1),
        resetTime: entry.resetTime,
      });
    }

    if (entry) {
      // Refresh an expired key: move it to the end of insertion order.
      this.hits.delete(key);
    } else if (this.hits.size >= MEMORY_STORE_MAX_ENTRIES) {
      this.evict();
    }

    const resetTime = now + windowMs;
    this.hits.set(key, { count: 1, resetTime });
    return Promise.resolve({ total: 1, remaining: 0, resetTime });
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (now > entry.resetTime) {
        this.hits.delete(key);
      }
    }
    // Still full: drop oldest entries (Map preserves insertion order).
    while (this.hits.size >= MEMORY_STORE_MAX_ENTRIES) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }

  get size(): number {
    return this.hits.size;
  }

  reset(key: string): Promise<void> {
    this.hits.delete(key);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.hits.clear();
    return Promise.resolve();
  }
}

class RedisStore implements RateLimiterStore {
  private client: RedisClient;
  private keyPrefix: string;

  constructor(redisUrl: string, keyPrefix = 'ratelimit:') {
    this.client = new RedisClient(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 100, 3000);
      },
      lazyConnect: true,
    });
    this.keyPrefix = keyPrefix;

    this.client.on('error', (err: Error) => {
      logger.error({ err }, 'Redis rate limiter connection error');
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
    multi.expire(fullKey, windowSec, 'NX');
    const results = await multi.exec();

    if (!results) {
      throw new Error('Redis multi exec returned null');
    }

    const err = results[0][0];
    if (err) {
      throw err;
    }
    const total = results[0][1] as number;

    return { total, remaining: Math.max(0, total - 1), resetTime };
  }

  async reset(key: string): Promise<void> {
    const fullKey = `${this.keyPrefix}${key}`;
    await this.client.del(fullKey);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

let redisStore: RedisStore | null = null;
let redisUsable = false;
let memoryStore: MemoryStore | null = null;
let redisCloseLogged = false;

function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore();
  }
  return memoryStore;
}

function ensureRedisStore(redisUrl: string): RedisStore {
  if (!redisStore) {
    const store = new RedisStore(redisUrl);
    redisStore = store;
    store
      .connect()
      .then(() => {
        redisUsable = true;
        logger.info('Redis rate limiter connected');
      })
      .catch((err: Error) => {
        redisUsable = false;
        logger.error(
          { err },
          'Failed to connect to Redis for rate limiting, using in-process memory store'
        );
      });
  }
  return redisStore;
}

function markRedisUnusable(err: Error): void {
  if (redisUsable || !redisCloseLogged) {
    logger.error(
      { err },
      'Redis rate limiter failed at runtime, switching to in-process memory store'
    );
  }
  redisUsable = false;
  redisCloseLogged = true;
}

/**
 * Returns the store that should currently own the counters.
 * Policy: Redis when configured and healthy, otherwise an in-process
 * bounded MemoryStore. The limiter never silently disables itself.
 */
export function getRateLimiterStore(): RateLimiterStore {
  const env = getEnv();

  if (env.REDIS_URL) {
    const store = ensureRedisStore(env.REDIS_URL);
    if (redisUsable) {
      return store;
    }
    return getMemoryStore();
  }

  return getMemoryStore();
}

async function incrementWithFallback(key: string, windowMs: number): Promise<RateLimitInfo> {
  const store = getRateLimiterStore();
  try {
    return await store.increment(key, windowMs);
  } catch (err) {
    // Primary store failed mid-request: mark it unusable and count this
    // request in the in-process fallback so the limit still applies.
    markRedisUnusable(err as Error);
    return await getMemoryStore().increment(key, windowMs);
  }
}

function applyHeaders(res: Response, info: RateLimitInfo, max: number): void {
  res.setHeader('X-RateLimit-Limit', max.toString());
  res.setHeader('X-RateLimit-Remaining', Math.max(0, max - info.total).toString());
  res.setHeader('X-RateLimit-Reset', Math.ceil(info.resetTime / 1000).toString());
}

function tooManyRequests(res: Response, info?: RateLimitInfo): void {
  if (info) {
    // RFC 6585: 429 responses SHOULD carry Retry-After so clients know when
    // the window resets instead of guessing or hammering the endpoint.
    const retryAfterSeconds = Math.max(1, Math.ceil((info.resetTime - Date.now()) / 1000));
    res.setHeader('Retry-After', retryAfterSeconds.toString());
  }
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests' },
  });
}

/**
 * Pre-authentication layer: keyed strictly by client IP.
 * Never trusts the Authorization header — an unverified Bearer prefix is
 * client-controlled and must not be able to mint unlimited buckets.
 */
export function createIpRateLimiterMiddleware() {
  const env = getEnv();

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `ip:${req.ip}`;
    try {
      const info = await incrementWithFallback(key, env.RATE_LIMIT_WINDOW_MS);
      applyHeaders(res, info, env.RATE_LIMIT_MAX);
      if (info.total > env.RATE_LIMIT_MAX) {
        return tooManyRequests(res, info);
      }
      next();
    } catch (err) {
      // Last-resort failure (even the memory store failed): fail closed.
      // Silently allowing the request would disable the limiter entirely.
      logger.error({ err, key }, 'Rate limiter failed, rejecting request');
      return tooManyRequests(res);
    }
  };
}

/**
 * Post-authentication layer: keyed by the verified API-key identity so
 * tenants are isolated from each other. Only mounted after authMiddleware.
 */
export function createIdentityRateLimiterMiddleware() {
  const env = getEnv();

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.apiKeyId !== undefined ? `key:${req.apiKeyId}` : `ip:${req.ip}`;
    try {
      const info = await incrementWithFallback(key, env.RATE_LIMIT_WINDOW_MS);
      applyHeaders(res, info, env.RATE_LIMIT_MAX);
      if (info.total > env.RATE_LIMIT_MAX) {
        return tooManyRequests(res, info);
      }
      next();
    } catch (err) {
      logger.error({ err, key }, 'Rate limiter failed, rejecting request');
      return tooManyRequests(res);
    }
  };
}

export async function closeRateLimiterStore(): Promise<void> {
  const closers: Promise<void>[] = [];
  if (redisStore) {
    closers.push(redisStore.close().catch(() => undefined));
    redisStore = null;
    redisUsable = false;
    redisCloseLogged = false;
  }
  if (memoryStore) {
    closers.push(memoryStore.close());
    memoryStore = null;
  }
  await Promise.all(closers);
}
