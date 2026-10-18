import { describe, it, expect } from "vitest";
import { getTestPool, getTestDb } from "./setup.js";
import { accounts, users } from "../db/schema/index.js";
import { softDeletePlan, insertPlan } from "../infrastructure/repositories/planRepository.js";

// Direct-SQL tests for database constraints. These deliberately bypass all
// application pre-validation to prove the database itself enforces the
// invariants the project claims (source of truth under concurrency).

async function createAccount(name: string): Promise<bigint> {
  const db = getTestDb();
  const [row] = await db.insert(accounts).values({ name }).returning({ id: accounts.id }).execute();
  return row.id;
}

async function createCustomPlan(accountId: bigint, name: string, type: "account" | "user"): Promise<bigint> {
  const plan = await insertPlan(
    getTestDb(),
    name,
    type,
    accountId,
    1000n,
    100n
  );
  return plan.id;
}

async function createUser(accountId: bigint, clientUserId: string): Promise<bigint> {
  const db = getTestDb();
  const [row] = await db
    .insert(users)
    .values({ accountId, clientUserId })
    .returning({ id: users.id })
    .execute();
  return row.id;
}

async function insertAssignment(
  accountId: bigint,
  userId: bigint | null,
  planId: bigint,
  from: Date,
  to: Date | null
): Promise<void> {
  await getTestPool().query(
    `INSERT INTO plan_assignments (account_id, user_id, plan_id, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, userId, planId, from, to]
  );
}

function expectPgError(fn: () => Promise<unknown>, code: string) {
  return fn().then(
    () => {
      throw new Error(`expected PostgreSQL error ${code}, but statement succeeded`);
    },
    (err: { code?: string }) => {
      expect(err.code).toBe(code);
    }
  );
}

describe("Database constraints (direct SQL, no application pre-validation)", () => {
  it("rejects overlapping account-level assignments with 23P01 (exclusion constraint)", async () => {
    const accountId = await createAccount("db-acct-overlap");
    const planId = await createCustomPlan(accountId, "db-acct-plan", "account");

    const start = new Date("2026-10-01T00:00:00Z");
    await insertAssignment(accountId, null, planId, start, new Date("2026-10-05T00:00:00Z"));

    // Overlapping bounded range, different plan row not required
    await expectPgError(
      () => insertAssignment(accountId, null, planId, new Date("2026-10-03T00:00:00Z"), new Date("2026-10-07T00:00:00Z")),
      "23P01"
    );
  });

  it("rejects overlapping user-level assignments with 23P01 (exclusion constraint)", async () => {
    const accountId = await createAccount("db-user-overlap");
    const planId = await createCustomPlan(accountId, "db-user-plan", "user");
    const userId = await createUser(accountId, "db-user-1");

    const start = new Date("2026-10-01T00:00:00Z");
    await insertAssignment(accountId, userId, planId, start, new Date("2026-10-05T00:00:00Z"));

    await expectPgError(
      () => insertAssignment(accountId, userId, planId, new Date("2026-10-03T00:00:00Z"), new Date("2026-10-07T00:00:00Z")),
      "23P01"
    );
  });

  it("accepts adjacent half-open ranges and zero-width superseded rows", async () => {
    const accountId = await createAccount("db-adjacent");
    const planId = await createCustomPlan(accountId, "db-adj-plan", "account");

    const start = new Date("2026-10-01T00:00:00Z");
    const day1 = new Date("2026-10-02T00:00:00Z");
    const day2 = new Date("2026-10-03T00:00:00Z");

    await insertAssignment(accountId, null, planId, start, day1);   // [Oct1, Oct2)
    await insertAssignment(accountId, null, planId, day1, day2);    // adjacent [Oct2, Oct3)
    await insertAssignment(accountId, null, planId, day2, day2);    // zero-width (superseded audit row)

    // An open-ended row starting at day2 does not overlap the zero-width row
    await insertAssignment(accountId, null, planId, day2, null);
  });

  it("rejects inverted ranges with 23514 (chk_assignment_range)", async () => {
    const accountId = await createAccount("db-inverted");
    const planId = await createCustomPlan(accountId, "db-inv-plan", "account");

    await expectPgError(
      () =>
        insertAssignment(
          accountId,
          null,
          planId,
          new Date("2026-10-05T00:00:00Z"),
          new Date("2026-10-04T00:00:00Z")
        ),
      "23514"
    );
  });

  it("enforces unique live account names (uq_accounts_name)", async () => {
    await createAccount("db-dup-account");
    await expectPgError(() => createAccount("db-dup-account"), "23505");
  });

  it("allows reusing a plan name after soft delete (uq_*_plans ignores deleted rows)", async () => {
    const accountId = await createAccount("db-name-reuse");
    const tx = getTestDb();
    const first = await insertPlan(tx, "Reusable Name", "account", accountId, 100n, 10n);
    await softDeletePlan(tx, first.id);

    // Same name again must now succeed
    const second = await insertPlan(tx, "Reusable Name", "account", accountId, 200n, 20n);
    expect(second.id).not.toBe(first.id);
  });

  it("keeps the usage_counters foreign key (bogus user id rejected with 23503)", async () => {
    const accountId = await createAccount("db-fk-check");
    await expectPgError(
      () =>
        getTestPool().query(
          `INSERT INTO usage_counters (account_id, user_id, period_start, counter)
           VALUES ($1, 999999999, DATE '2026-10-01', 0)`,
          [accountId]
        ),
      "23503"
    );
  });

  it("rejects negative counters with 23514 (chk_counter_non_negative)", async () => {
    const accountId = await createAccount("db-neg-counter");
    await expectPgError(
      () =>
        getTestPool().query(
          `INSERT INTO usage_counters (account_id, user_id, period_start, counter)
           VALUES ($1, NULL, DATE '2026-10-01', -1)`,
          [accountId]
        ),
      "23514"
    );
  });

  it("rejects duplicate current account assignment with 23505 (partial unique index)", async () => {
    const accountId = await createAccount("db-two-current");
    const planId = await createCustomPlan(accountId, "db-two-current-plan", "account");
    const start = new Date("2026-10-01T00:00:00Z");

    await insertAssignment(accountId, null, planId, start, null);
    await expectPgError(() => insertAssignment(accountId, null, planId, start, null), "23505");
  });

  it("rejects cross-account user pairing on usage_counters (composite FK, 23503)", async () => {
    const accountA = await createAccount("db-comp-a");
    const accountB = await createAccount("db-comp-b");
    const userOfA = await createUser(accountA, "user-of-a");

    await expectPgError(
      () =>
        getTestPool().query(
          `INSERT INTO usage_counters (account_id, user_id, period_start, counter)
           VALUES ($1, $2, DATE '2026-10-01', 0)`,
          [accountB, userOfA]
        ),
      "23503"
    );
  });

  it("rejects cross-account user pairing on usage_requests (composite FK, 23503)", async () => {
    const accountA = await createAccount("db-comp-req-a");
    const accountB = await createAccount("db-comp-req-b");
    const userOfA = await createUser(accountA, "req-user-of-a");

    await expectPgError(
      () =>
        getTestPool().query(
          `INSERT INTO usage_requests
             (account_id, user_id, idempotency_key, request_hash, units, decision, period_start)
           VALUES ($1, $2, 'composite-fk-req', $3, 1, 'accepted', DATE '2026-10-01')`,
          [accountB, userOfA, "a".repeat(64)]
        ),
      "23503"
    );
  });

  it("rejects cross-account user pairing on plan_assignments (composite FK, 23503)", async () => {
    const accountA = await createAccount("db-comp-asn-a");
    const accountB = await createAccount("db-comp-asn-b");
    const userOfA = await createUser(accountA, "asn-user-of-a");
    // User-type plan so the plan-type trigger passes and only the
    // composite tenant FK can reject the row.
    const userPlan = await createCustomPlan(accountA, "db-comp-asn-plan", "user");

    await expectPgError(
      () => insertAssignment(accountB, userOfA, userPlan, new Date("2026-10-01T00:00:00Z"), null),
      "23503"
    );
  });

  it("accepts a correctly paired (account_id, user_id) row (control)", async () => {
    const accountId = await createAccount("db-comp-ok");
    const userId = await createUser(accountId, "paired-user");

    await getTestPool().query(
      `INSERT INTO usage_counters (account_id, user_id, period_start, counter)
       VALUES ($1, $2, DATE '2026-10-01', 0)`,
      [accountId, userId]
    );
  });
});
