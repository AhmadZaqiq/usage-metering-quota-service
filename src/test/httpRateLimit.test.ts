import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { setupBasicTestContext, TestContext } from './utils.js';

// Two-layer fail-closed rate limiting observed purely over HTTP: requests are
// counted per authenticated key after auth resolves (and per IP before auth).
// With the default budget of 100 requests per 60s, the 101st request must be
// rejected with 429 RATE_LIMITED and the documented headers.
// Kept in its own file so the in-process MemoryStore of other test files
// cannot share counters with this budget-exhaustion scenario.

describe('HTTP rate limit exhaustion', () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
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
});
