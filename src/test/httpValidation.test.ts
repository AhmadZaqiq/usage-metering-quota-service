import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { setupBasicTestContext, TestContext } from './utils.js';
import { getUsageHistory } from '../application/usage/usageHistoryService.js';

// BR-06: empty userId strings must be rejected at the schema boundary
// (400 VALIDATION_ERROR) instead of reaching services as a user-scoped
// request with a meaningless subject.
describe('HTTP input validation', () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    app = createApp();
    context = await setupBasicTestContext();
  });

  it('POST /usage rejects an empty userId with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`)
      .send({ userId: '', units: '1', idempotencyKey: 'empty-user-id' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    // Rejected at validation: nothing was persisted.
    const page = await getUsageHistory(BigInt(context.account.id), 1, 10);
    expect(page.items).toHaveLength(0);
  });

  it('POST /assignments rejects an empty userId with 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/assignments')
      .set('Authorization', `Bearer ${context.apiKey.key}`)
      .send({ planId: context.userPlan.id, userId: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /usage still accepts a valid userId (positive control, deprecated idempotencyKey alias)', async () => {
    const res = await request(app)
      .post('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`)
      .send({ userId: context.user.clientUserId, units: '1', idempotencyKey: 'valid-user-id' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('accepted');
  });

  it('POST /usage accepts the canonical requestId field and history exposes requestId only', async () => {
    const res = await request(app)
      .post('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`)
      .send({ userId: context.user.clientUserId, units: '1', requestId: 'canonical-key-1' });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('accepted');

    const history = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`);
    expect(history.status).toBe(200);
    const [item] = history.body.items as Record<string, unknown>[];
    expect(item.requestId).toBe('canonical-key-1');
    expect(item).not.toHaveProperty('idempotencyKey');
  });

  it('POST /usage rejects a body that sends both requestId and idempotencyKey', async () => {
    const res = await request(app)
      .post('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`)
      .send({ units: '1', requestId: 'both-a', idempotencyKey: 'both-b' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const page = await getUsageHistory(BigInt(context.account.id), 1, 10);
    expect(page.items).toHaveLength(0);
  });

  it('POST /usage rejects a body with neither requestId nor idempotencyKey', async () => {
    const res = await request(app)
      .post('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`)
      .send({ units: '1' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error)).toContain('requestId');

    const page = await getUsageHistory(BigInt(context.account.id), 1, 10);
    expect(page.items).toHaveLength(0);
  });

  it('POST /usage maps malformed JSON to 400 VALIDATION_ERROR, never 500', async () => {
    const res = await request(app)
      .post('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`)
      .set('Content-Type', 'application/json')
      .send('{"units": "1", "idempotencyKey": "truncated"');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Malformed JSON payload');
  });

  it('POST /usage maps a payload above the size limit to 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`)
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({ units: '1', idempotencyKey: 'oversize', padding: 'x'.repeat(70 * 1024) })
      );

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('POST /usage rejects zero, negative, and over-limit units with 400 and consumes nothing', async () => {
    for (const units of ['0', '-1', '99999999999999999999999999999']) {
      const res = await request(app)
        .post('/usage')
        .set('Authorization', `Bearer ${context.apiKey.key}`)
        .send({ units, idempotencyKey: `units-boundary-${units}` });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    const page = await getUsageHistory(BigInt(context.account.id), 1, 10);
    expect(page.items).toHaveLength(0);
  });

  it('GET /usage rejects out-of-range pagination parameters with 400', async () => {
    const pageZero = await request(app)
      .get('/usage?page=0')
      .set('Authorization', `Bearer ${context.apiKey.key}`);
    expect(pageZero.status).toBe(400);
    expect(pageZero.body.error.code).toBe('VALIDATION_ERROR');

    const limitTooLarge = await request(app)
      .get('/usage?limit=101')
      .set('Authorization', `Bearer ${context.apiKey.key}`);
    expect(limitTooLarge.status).toBe(400);
    expect(limitTooLarge.body.error.code).toBe('VALIDATION_ERROR');
  });
});
