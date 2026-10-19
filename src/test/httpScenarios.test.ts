import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { setupBasicTestContext, TestContext } from './utils.js';

// Item 4: end-to-end HTTP coverage of the documented API contract — the
// quota decisions and rejection reasons exactly as clients observe them,
// history pagination, the plan CRUD + assignment flow, idempotency, and
// cross-tenant isolation, all through the real Express pipeline.

describe('HTTP usage decision scenarios', () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    app = createApp();
    context = await setupBasicTestContext();
  });

  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
  const postUsage = (body: Record<string, unknown>) =>
    request(app).post('/usage').set(auth(context.apiKey.key)).send(body);

  it('accepts a valid user-scoped request with string-serialized counters', async () => {
    const res = await postUsage({
      userId: context.user.clientUserId,
      units: '7',
      idempotencyKey: 'scen-accept-1',
    });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('accepted');
    expect(res.body.accountRemaining).toBe('993');
    expect(res.body.userRemaining).toBe('93');
    expect(res.body.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.rejectionReason).toBeUndefined();
  });

  it('rejects over-max units with max_per_request_exceeded without consuming quota', async () => {
    const res = await postUsage({
      userId: context.user.clientUserId,
      units: '11',
      idempotencyKey: 'scen-perreq-1',
    });

    expect(res.status).toBe(200); // business rejection is not an HTTP failure
    expect(res.body.decision).toBe('rejected');
    expect(res.body.rejectionReason).toBe('max_per_request_exceeded');
    expect(res.body.accountRemaining).toBe('1000'); // no quota was consumed

    // Rejected decisions are audited in history, but they never move counters.
    const history = await request(app).get('/usage').set(auth(context.apiKey.key));
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].decision).toBe('rejected');
    expect(history.body.items[0].rejectionReason).toBe('max_per_request_exceeded');
  });

  it('rejects with user_quota_exceeded once the user allowance is exhausted', async () => {
    const first = await postUsage({
      userId: context.user.clientUserId,
      units: '10',
      idempotencyKey: 'scen-userquota-consume',
    });
    expect(first.body.decision).toBe('accepted');
    expect(first.body.userRemaining).toBe('90');

    // Item 9: reducing the allowance below existing usage clamps remaining to 0.
    const patched = await request(app)
      .patch(`/plans/${context.userPlan.id}`)
      .set(auth(context.apiKey.key))
      .send({ monthlyAllowance: '5' });
    expect(patched.status).toBe(200);

    const res = await postUsage({
      userId: context.user.clientUserId,
      units: '1',
      idempotencyKey: 'scen-userquota-1',
    });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('rejected');
    expect(res.body.rejectionReason).toBe('user_quota_exceeded');
    expect(res.body.userRemaining).toBe('0'); // clamped, never negative
    expect(res.body.accountRemaining).toBe('990'); // account quota untouched by rejection
  });

  it('rejects with account_quota_exceeded when the account allowance is exhausted', async () => {
    const first = await postUsage({
      units: '50',
      idempotencyKey: 'scen-acctquota-consume',
    });
    expect(first.body.decision).toBe('accepted');
    expect(first.body.accountRemaining).toBe('950');

    const patched = await request(app)
      .patch(`/plans/${context.accountPlan.id}`)
      .set(auth(context.apiKey.key))
      .send({ monthlyAllowance: '10' });
    expect(patched.status).toBe(200);

    const res = await postUsage({
      userId: context.user.clientUserId,
      units: '10',
      idempotencyKey: 'scen-acctquota-1',
    });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('rejected');
    expect(res.body.rejectionReason).toBe('account_quota_exceeded'); // account checked first
    expect(res.body.accountRemaining).toBe('0'); // clamped, never negative
  });

  it('replays the original committed result for a repeated idempotency key', async () => {
    const first = await postUsage({
      userId: context.user.clientUserId,
      units: '5',
      idempotencyKey: 'scen-idem-replay',
    });
    expect(first.status).toBe(200);
    expect(first.body.decision).toBe('accepted');
    expect(first.body.accountRemaining).toBe('995');

    const second = await postUsage({
      userId: context.user.clientUserId,
      units: '5',
      idempotencyKey: 'scen-idem-replay',
    });
    expect(second.status).toBe(200);
    expect(second.body.decision).toBe('accepted');
    // Same committed result as the original, not a second consumption.
    expect(second.body.accountRemaining).toBe('995');

    const history = await request(app).get('/usage').set(auth(context.apiKey.key));
    const matches = history.body.items.filter(
      (i: { requestId: string }) => i.requestId === 'scen-idem-replay'
    );
    expect(matches).toHaveLength(1);
  });

  it('replays a max_per_request_exceeded rejection with the stored decision but without limitScope', async () => {
    const body = {
      userId: context.user.clientUserId,
      units: '11', // user plan per-request cap is 10
      idempotencyKey: 'scen-limitscope-replay',
    };

    // Live evaluation carries limitScope (documented contract).
    const first = await postUsage(body);
    expect(first.status).toBe(200);
    expect(first.body.decision).toBe('rejected');
    expect(first.body.rejectionReason).toBe('max_per_request_exceeded');
    expect(first.body.limitScope).toBe('user');
    expect(first.body.accountRemaining).toBe('1000');
    expect(first.body.userRemaining).toBe('100');

    // Replay returns the same persisted decision and stored remainings...
    const replay = await postUsage(body);
    expect(replay.status).toBe(200);
    expect(replay.body.decision).toBe(first.body.decision);
    expect(replay.body.rejectionReason).toBe(first.body.rejectionReason);
    expect(replay.body.accountRemaining).toBe(first.body.accountRemaining);
    expect(replay.body.userRemaining).toBe(first.body.userRemaining);
    expect(replay.body.periodStart).toBe(first.body.periodStart);
    // ...but continues to omit limitScope, which is not persisted
    // (README.md: replay omits it rather than re-evaluating quota).
    expect('limitScope' in replay.body).toBe(false);
  });

  it('converges concurrent duplicate rejections on one persisted row, with limitScope only on the live evaluation', async () => {
    const body = {
      units: '101', // account-scoped; account plan per-request cap is 100
      idempotencyKey: 'scen-limitscope-race',
    };

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => postUsage(body)),
    );

    // Every duplicate observes the identical persisted decision.
    const distinct = new Set(
      responses.map(
        (r) => `${r.status}:${r.body.decision}:${r.body.rejectionReason}:${r.body.accountRemaining}`,
      ),
    );
    expect(distinct.size).toBe(1);
    const [only] = responses;
    expect(only.status).toBe(200);
    expect(only.body.decision).toBe('rejected');
    expect(only.body.rejectionReason).toBe('max_per_request_exceeded');
    expect(only.body.accountRemaining).toBe('1000');

    // Exactly the winning INSERT returns a live evaluation (limitScope
    // present); every other duplicate converges through the replay or
    // race-lost path, which omits it by contract.
    const live = responses.filter((r) => r.body.limitScope !== undefined);
    const converged = responses.filter((r) => r.body.limitScope === undefined);
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(converged.length).toBeGreaterThanOrEqual(1);
    for (const res of live) {
      expect(res.body.limitScope).toBe('account');
    }

    const history = await request(app).get('/usage').set(auth(context.apiKey.key));
    const matches = history.body.items.filter(
      (i: { requestId: string }) => i.requestId === 'scen-limitscope-race',
    );
    expect(matches).toHaveLength(1); // eight requests, one decision row
  });

  it('returns 409 CONFLICT when an idempotency key is reused with different input', async () => {
    const first = await postUsage({
      userId: context.user.clientUserId,
      units: '5',
      requestId: 'scen-idem-conflict',
    });
    expect(first.status).toBe(200);

    const second = await postUsage({
      userId: context.user.clientUserId,
      units: '6',
      requestId: 'scen-idem-conflict',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('returns 409 CONFLICT when the same requestId is reused for a different user', async () => {
    const first = await postUsage({
      userId: context.user.clientUserId,
      units: '1',
      requestId: 'scen-idem-user-conflict',
    });
    expect(first.status).toBe(200);

    const created = await request(app)
      .post('/users')
      .set(auth(context.apiKey.key))
      .send({ clientUserId: 'scen-idem-other-user' });
    expect(created.status).toBe(201);

    const second = await postUsage({
      userId: 'scen-idem-other-user',
      units: '1',
      requestId: 'scen-idem-user-conflict',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('returns 404 when the user does not belong to the authenticated account', async () => {
    const res = await postUsage({
      userId: 'user-from-another-account',
      units: '1',
      idempotencyKey: 'scen-unknown-user',
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('HTTP usage history pagination', () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    app = createApp();
    context = await setupBasicTestContext();
    for (const [index, units] of ['1', '2', '3'].entries()) {
      const res = await request(app)
        .post('/usage')
        .set('Authorization', `Bearer ${context.apiKey.key}`)
        .send({
          userId: context.user.clientUserId,
          units,
          idempotencyKey: `page-item-${index + 1}`,
        });
      expect(res.status).toBe(200);
    }
  });

  it('returns items page by page with correct totals', async () => {
    const page1 = await request(app)
      .get('/usage?limit=2')
      .set('Authorization', `Bearer ${context.apiKey.key}`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBe(3);
    expect(page1.body.page).toBe(1);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.totalPages).toBe(2);

    const page2 = await request(app)
      .get('/usage?page=2&limit=2')
      .set('Authorization', `Bearer ${context.apiKey.key}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.page).toBe(2);

    const seenKeys = [...page1.body.items, ...page2.body.items].map(
      (i: { requestId: string }) => i.requestId
    );
    expect(seenKeys.sort()).toEqual(['page-item-1', 'page-item-2', 'page-item-3']);
  });

  it('serializes bigint counters as strings inside history items', async () => {
    const res = await request(app)
      .get('/usage')
      .set('Authorization', `Bearer ${context.apiKey.key}`);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(typeof item.accountRemaining).toBe('string');
      if (item.userRemaining !== null && item.userRemaining !== undefined) {
        expect(typeof item.userRemaining).toBe('string');
      }
    }
  });
});

describe('HTTP plan management and assignment flow', () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    app = createApp();
    context = await setupBasicTestContext();
  });

  const auth = () => ({ Authorization: `Bearer ${context.apiKey.key}` });

  it('runs the full plan lifecycle: create, read, update, assign, delete', async () => {
    const created = await request(app).post('/plans').set(auth()).send({
      name: 'HTTP Lifecycle Plan',
      type: 'account',
      monthlyAllowance: '5000',
      maxUnitsPerRequest: '50',
    });
    expect(created.status).toBe(201);
    expect(created.body.monthlyAllowance).toBe('5000');
    expect(created.body.maxUnitsPerRequest).toBe('50');
    const planId = created.body.id;

    const read = await request(app).get(`/plans/${planId}`).set(auth());
    expect(read.status).toBe(200);
    expect(read.body.name).toBe('HTTP Lifecycle Plan');

    const patched = await request(app)
      .patch(`/plans/${planId}`)
      .set(auth())
      .send({ name: 'HTTP Lifecycle Plan v2' });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('HTTP Lifecycle Plan v2');

    const assigned = await request(app).post('/assignments').set(auth()).send({ planId });
    expect(assigned.status).toBe(201);

    const current = await request(app).get('/assignments/current').set(auth());
    expect(current.status).toBe(200);
    expect(current.body.account).not.toBeNull();
    expect(current.body.account.planId).toBe(planId);
    expect(current.body.account.isCurrent).toBe(true);
    expect(current.body.account.effectiveTo).toBeNull();
    expect(current.body.account.userId).toBeNull();

    const deleted = await request(app).delete(`/plans/${planId}`).set(auth());
    expect(deleted.status).toBe(409); // plan is in use by a current assignment

    const fresh = await request(app).post('/plans').set(auth()).send({
      name: 'HTTP Disposable Plan',
      type: 'account',
      monthlyAllowance: '10',
      maxUnitsPerRequest: '10',
    });
    expect(fresh.status).toBe(201);
    const removed = await request(app).delete(`/plans/${fresh.body.id}`).set(auth());
    expect(removed.status).toBe(204);
    const afterDelete = await request(app).get(`/plans/${fresh.body.id}`).set(auth());
    expect(afterDelete.status).toBe(404);
  });

  it("hides another account's plan and user behind HTTP 404/403", async () => {
    const other = await setupBasicTestContext();
    const otherOnlyUser = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${other.apiKey.key}`)
      .send({ clientUserId: 'user-only-in-other-account' });
    expect(otherOnlyUser.status).toBe(201);

    const patchOtherPlan = await request(app)
      .patch(`/plans/${other.accountPlan.id}`)
      .set(auth())
      .send({ name: 'hijacked' });
    expect(patchOtherPlan.status).toBe(404);

    const assignOtherPlan = await request(app)
      .post('/assignments')
      .set(auth())
      .send({ planId: other.accountPlan.id });
    expect(assignOtherPlan.status).toBe(403);

    const usageOtherUser = await request(app).post('/usage').set(auth()).send({
      userId: 'user-only-in-other-account',
      units: '1',
      idempotencyKey: 'scen-cross-user',
    });
    expect(usageOtherUser.status).toBe(404);
    expect(usageOtherUser.body.error.code).toBe('NOT_FOUND');
  });
});

describe('HTTP usage history filtering and tenant isolation', () => {
  let app: ReturnType<typeof createApp>;
  let context: TestContext;

  beforeEach(async () => {
    app = createApp();
    context = await setupBasicTestContext();
  });

  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

  it("GET /usage?userId returns only that user's rows, excluding account-scoped rows", async () => {
    const accountScoped = await request(app)
      .post('/usage')
      .set(auth(context.apiKey.key))
      .send({ units: '2', requestId: 'filter-acct-1' });
    expect(accountScoped.status).toBe(200);

    const userScoped = await request(app)
      .post('/usage')
      .set(auth(context.apiKey.key))
      .send({ userId: context.user.clientUserId, units: '3', requestId: 'filter-user-1' });
    expect(userScoped.status).toBe(200);

    const filtered = await request(app)
      .get(`/usage?userId=${context.user.clientUserId}`)
      .set(auth(context.apiKey.key));
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].requestId).toBe('filter-user-1');
    expect(filtered.body.total).toBe(1);

    const unfiltered = await request(app).get('/usage').set(auth(context.apiKey.key));
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.items).toHaveLength(2);
  });

  it('GET /usage?userId returns 404 for a user unknown to the account', async () => {
    const res = await request(app)
      .get('/usage?userId=no-such-client-user')
      .set(auth(context.apiKey.key));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('F-ISO-1: the same clientUserId in two accounts resolves and filters independently', async () => {
    const shared = 'iso-shared-client-user';
    const ctxB = await setupBasicTestContext();

    // Account A: create the user, assign A's user plan, consume 3 units.
    const userA = await request(app)
      .post('/users')
      .set(auth(context.apiKey.key))
      .send({ clientUserId: shared });
    expect(userA.status).toBe(201);
    const assignA = await request(app)
      .post('/assignments')
      .set(auth(context.apiKey.key))
      .send({ planId: context.userPlan.id, userId: shared });
    expect(assignA.status).toBe(201);
    const usageA = await request(app)
      .post('/usage')
      .set(auth(context.apiKey.key))
      .send({ userId: shared, units: '3', requestId: 'iso-a-usage' });
    expect(usageA.status).toBe(200);
    expect(usageA.body.decision).toBe('accepted');

    // Account B: same clientUserId string, independent user row and plan.
    const userB = await request(app)
      .post('/users')
      .set(auth(ctxB.apiKey.key))
      .send({ clientUserId: shared });
    expect(userB.status).toBe(201);
    expect(userB.body.id).not.toBe(userA.body.id);
    const assignB = await request(app)
      .post('/assignments')
      .set(auth(ctxB.apiKey.key))
      .send({ planId: ctxB.userPlan.id, userId: shared });
    expect(assignB.status).toBe(201);
    const usageB = await request(app)
      .post('/usage')
      .set(auth(ctxB.apiKey.key))
      .send({ userId: shared, units: '4', requestId: 'iso-b-usage' });
    expect(usageB.status).toBe(200);
    expect(usageB.body.decision).toBe('accepted');

    // The same filter string returns account-scoped results on each side.
    const histA = await request(app)
      .get(`/usage?userId=${shared}`)
      .set(auth(context.apiKey.key));
    expect(histA.status).toBe(200);
    expect(histA.body.items).toHaveLength(1);
    expect(histA.body.items[0].units).toBe('3');
    expect(histA.body.items[0].requestId).toBe('iso-a-usage');

    const histB = await request(app)
      .get(`/usage?userId=${shared}`)
      .set(auth(ctxB.apiKey.key));
    expect(histB.status).toBe(200);
    expect(histB.body.items).toHaveLength(1);
    expect(histB.body.items[0].units).toBe('4');
    expect(histB.body.items[0].requestId).toBe('iso-b-usage');
  });
});
