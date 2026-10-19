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

// Bounds the in-process store so attacker-controlled key cardinality
// (many distinct IPs) cannot grow the map without limit.
const MEMORY_STORE_MAX_ENTRIES = 10_000;

export class MemoryStore implements RateLimiterStore {
  private hits = new Map<string, { count: number; resetTime: number }>();

  // Increment is fully synchronous between read and write, so concurrent
  // requests within this process cannot interleave and lose counts.
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

let memoryStore: MemoryStore | null = null;

function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore();
  }
  return memoryStore;
}

/**
 * Returns the process-wide rate-limit store.
 *
 * The limiter is in-process only: counters are local to this Node.js
 * process, reset on restart, and never shared across application replicas.
 * The store is bounded (see MEMORY_STORE_MAX_ENTRIES) and never disables
 * itself — enforcement always continues within the process.
 */
export function getRateLimiterStore(): RateLimiterStore {
  return getMemoryStore();
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
      const info = await getRateLimiterStore().increment(key, env.RATE_LIMIT_WINDOW_MS);
      applyHeaders(res, info, env.RATE_LIMIT_MAX);
      if (info.total > env.RATE_LIMIT_MAX) {
        return tooManyRequests(res, info);
      }
      next();
    } catch (err) {
      // Last-resort failure (the store itself failed): fail closed.
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
      const info = await getRateLimiterStore().increment(key, env.RATE_LIMIT_WINDOW_MS);
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
  if (memoryStore) {
    await memoryStore.close();
    memoryStore = null;
  }
}
