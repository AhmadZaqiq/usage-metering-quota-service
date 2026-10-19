import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { closeRateLimiterStore } from '../infrastructure/rateLimiter.js';
import { setupBasicTestContext, TestContext } from './utils.js';

// Two-layer fail-closed rate limiting observed purely over HTTP: requests are
// counted per authenticated key after auth resolves (and per IP before auth).
// With the default budget of 100 requests per 60s, the 101st request must be
// rejected with 429 RATE_LIMITED and the documented headers.
// The limiter store is process-wide, so each test resets it first; the store
// itself is in-process only (no external backend).

describe('HTTP rate limit exhaustion', () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    // Fresh counters for every test (models a restart; the limiter is
    // in-process and has no external store to clear).
    await closeRateLimiterStore();
    app = createApp();
    context = await setupBasicTestContext();
  });

  it(
    'returns 429 RATE_LIMITED once the default 100/60s budget is exhausted',
    { timeout: 60_000 },
    async () => {
      const key = context.apiKey.key;
      let limited: request.Response | undefined;
      let accepted = 0;

      for (let i = 0; i < 105; i++) {
        const res = await request(app).get('/plans').set('Authorization', `Bearer ${key}`);
        if (res.status === 429) {
          limited = res;
          break;
        }
        expect(res.status).toBe(200);
        accepted++;
      }

      expect(limited).toBeDefined();
      expect(limited!.body.error.code).toBe('RATE_LIMITED');
      expect(limited!.headers['retry-after']).toBeDefined();
      expect(Number(limited!.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
      expect(limited!.headers['x-ratelimit-remaining']).toBe('0');
      // The budget is 100; the limiter must not allow a meaningful overshoot.
      expect(accepted).toBeGreaterThanOrEqual(99);
      expect(accepted).toBeLessThanOrEqual(105);

      // Operational endpoints are mounted before the IP rate limiter and must
      // stay reachable while the API surface is saturated (orchestrator
      // probes and operator docs cannot depend on limiter budget).
      const live = await request(app).get('/health/live');
      expect(live.status).toBe(200);
      const ready = await request(app).get('/health/ready');
      expect(ready.status).toBe(200);
      const spec = await request(app).get('/docs/openapi.json');
      expect(spec.status).toBe(200);

      // The authenticated API surface remains saturated.
      const stillLimited = await request(app)
        .get('/plans')
        .set('Authorization', `Bearer ${key}`);
      expect(stillLimited.status).toBe(429);
    }
  );

  it(
    'enforces the shared in-process budget under a concurrent burst',
    { timeout: 60_000 },
    async () => {
      const key = context.apiKey.key;

      // One burst of 130 parallel requests: within a single Node.js process
      // the counter updates are synchronous, so exactly the configured
      // budget (100) may pass and the remaining 30 must be rejected —
      // no lost updates, no overshoot.
      const responses = await Promise.all(
        Array.from({ length: 130 }, () =>
          request(app).get('/plans').set('Authorization', `Bearer ${key}`)
        )
      );

      const accepted = responses.filter((r) => r.status === 200).length;
      const limited = responses.filter((r) => r.status === 429);
      expect(accepted).toBe(100);
      expect(limited).toHaveLength(30);

      const sample = limited[0]!;
      expect(sample.body.error.code).toBe('RATE_LIMITED');
      expect(sample.headers['retry-after']).toBeDefined();
      expect(sample.headers['x-ratelimit-limit']).toBe('100');
      expect(sample.headers['x-ratelimit-remaining']).toBe('0');
    }
  );
});
