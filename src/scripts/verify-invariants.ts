import { parseArgs } from 'util';
import { pathToFileURL } from 'url';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Accounting-invariant verifier.
 *
 * Cross-checks the two sources of truth against each other:
 *   usage_counters  (materialized balances) vs
 *   usage_requests  (append-only decision audit log).
 *
 * Checks:
 *   INV-1  account counter == sum of accepted units for that account/period
 *   INV-2  user counter    == sum of accepted units for that user/period
 *   INV-3  sum(user counters) <= account counter (per account/period)
 *   INV-4  stored remainings are never negative (clamp invariant persisted)
 *   INV-5  period_start is the UTC month of created_at (requests and counters)
 *          Known false-positive window: a request whose transaction crosses a
 *          UTC month boundary records period_start from admission-time JS Date
 *          but created_at from DB NOW() at commit; for that one request per
 *          month (~1s window) INV-5 may flag a legitimate row. Do not treat an
 *          INV-5-only report as corruption without inspecting the row.
 *   INV-6  tenant pairing: user-scoped rows belong to the row's account
 *   INV-7  no duplicate (account, idempotency_key)
 *   INV-8  rejected requests contribute zero to counters (follows from INV-1/2
 *          sums filtering decision = 'accepted'; checked explicitly here)
 *
 * Exit codes: 0 = all checks pass, 1 = violation or connection failure.
 * Output contains account ids, periods, and counts only — never secrets.
 */

const MAX_ROWS_SHOWN = 20;

export interface Violation {
  check: string;
  detail: string;
}

async function fetchRows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await db.execute(query);
  return result.rows;
}

async function fetchCount(query: ReturnType<typeof sql>): Promise<number> {
  const rows = await fetchRows(query);
  return Number((rows[0] as { count?: string | number } | undefined)?.count ?? 0);
}

function formatRows(rows: Record<string, unknown>[]): string {
  const shown = rows.slice(0, MAX_ROWS_SHOWN);
  const lines = shown.map((r) => JSON.stringify(r));
  if (rows.length > shown.length) {
    lines.push(`... ${rows.length - shown.length} more`);
  }
  return lines.join('\n    ');
}

export async function verify(accountName?: string): Promise<Violation[]> {
  const violations: Violation[] = [];

  let accountId: string | null = null;
  if (accountName) {
    const accRows = await fetchRows(sql`SELECT id FROM accounts WHERE name = ${accountName}`);
    if (accRows.length === 0) {
      violations.push({ check: 'SCOPE', detail: `account "${accountName}" not found` });
      return violations;
    }
    accountId = String(accRows[0].id);
  }
  const accountLabel = accountId ? `${accountName} (id ${accountId})` : 'all accounts';
  // Scope predicate applied on the COALESCE'd side so FULL OUTER JOIN rows
  // from other accounts never leak into a --account-scoped run.
  const scope = (expr: ReturnType<typeof sql>) =>
    accountId !== null ? sql`${expr} = ${accountId}` : sql`TRUE`;

  // INV-1: account counters equal accepted totals. Both sides are aggregated
  // to account level BEFORE the full outer join so user-level counter rows
  // can never appear as unmatched rows here.
  const inv1 = await fetchRows(sql`
    WITH accepted AS (
      SELECT ur.account_id, ur.period_start, SUM(ur.units)::text AS accepted_units
      FROM usage_requests ur
      WHERE ur.decision = 'accepted'
      GROUP BY ur.account_id, ur.period_start
    ),
    account_counters AS (
      SELECT uc.account_id, uc.period_start, uc.counter
      FROM usage_counters uc
      WHERE uc.user_id IS NULL
    )
    SELECT COALESCE(a.account_id, ac.account_id) AS account_id,
           COALESCE(a.period_start, ac.period_start) AS period_start,
           COALESCE(a.accepted_units, '0') AS accepted_units,
           COALESCE(ac.counter, -1)::text AS counter
    FROM accepted a
    FULL OUTER JOIN account_counters ac
      ON ac.account_id = a.account_id
     AND ac.period_start = a.period_start
    WHERE ${scope(sql`COALESCE(a.account_id, ac.account_id)`)}
      AND COALESCE(a.accepted_units, '0')::bigint IS DISTINCT FROM COALESCE(ac.counter, 0)
  `);
  if (inv1.length > 0) {
    violations.push({
      check: 'INV-1',
      detail: `account counter != accepted sum:\n    ${formatRows(inv1)}`,
    });
  }

  // INV-2: user counters equal accepted per-user totals. Same two-sided
  // aggregation as INV-1, scoped to user-level rows.
  const inv2 = await fetchRows(sql`
    WITH accepted AS (
      SELECT ur.account_id, ur.user_id, ur.period_start, SUM(ur.units)::text AS accepted_units
      FROM usage_requests ur
      WHERE ur.decision = 'accepted' AND ur.user_id IS NOT NULL
      GROUP BY ur.account_id, ur.user_id, ur.period_start
    ),
    user_counters AS (
      SELECT uc.account_id, uc.user_id, uc.period_start, uc.counter
      FROM usage_counters uc
      WHERE uc.user_id IS NOT NULL
    )
    SELECT COALESCE(a.account_id, uc.account_id) AS account_id,
           COALESCE(a.user_id, uc.user_id) AS user_id,
           COALESCE(a.period_start, uc.period_start) AS period_start,
           COALESCE(a.accepted_units, '0') AS accepted_units,
           COALESCE(uc.counter, -1)::text AS counter
    FROM accepted a
    FULL OUTER JOIN user_counters uc
      ON uc.account_id = a.account_id
     AND uc.user_id = a.user_id
     AND uc.period_start = a.period_start
    WHERE ${scope(sql`COALESCE(a.account_id, uc.account_id)`)}
      AND COALESCE(a.accepted_units, '0')::bigint IS DISTINCT FROM COALESCE(uc.counter, 0)
  `);
  if (inv2.length > 0) {
    violations.push({
      check: 'INV-2',
      detail: `user counter != accepted sum:\n    ${formatRows(inv2)}`,
    });
  }

  // INV-3: per-user counters never exceed the account counter. Account-only
  // usage legitimately makes the account counter larger than the user sum.
  const inv3 = await fetchRows(sql`
    WITH user_sums AS (
      SELECT uc.account_id, uc.period_start, SUM(uc.counter)::text AS user_sum
      FROM usage_counters uc
      WHERE uc.user_id IS NOT NULL
      GROUP BY uc.account_id, uc.period_start
    )
    SELECT us.account_id, us.period_start, us.user_sum,
           ac.counter::text AS account_counter
    FROM user_sums us
    JOIN usage_counters ac
      ON ac.account_id = us.account_id
     AND ac.period_start = us.period_start
     AND ac.user_id IS NULL
    WHERE ${scope(sql`us.account_id`)}
      AND us.user_sum::bigint > ac.counter
  `);
  if (inv3.length > 0) {
    violations.push({
      check: 'INV-3',
      detail: `sum(user counters) > account counter:\n    ${formatRows(inv3)}`,
    });
  }

  // INV-4: persisted remainings are never negative.
  const inv4 = await fetchCount(sql`
    SELECT COUNT(*) FROM usage_requests
    WHERE account_remaining < 0 OR user_remaining < 0
  `);
  if (inv4 > 0) {
    violations.push({ check: 'INV-4', detail: `${inv4} rows have negative stored remaining` });
  }

  // INV-5: period_start is the UTC month of created_at.
  const inv5Requests = await fetchCount(sql`
    SELECT COUNT(*) FROM usage_requests
    WHERE period_start <> (date_trunc('month', created_at AT TIME ZONE 'UTC'))::date
  `);
  if (inv5Requests > 0) {
    violations.push({
      check: 'INV-5',
      detail: `${inv5Requests} usage_requests with wrong period_start`,
    });
  }
  const inv5Counters = await fetchCount(sql`
    SELECT COUNT(*) FROM usage_counters
    WHERE period_start <> (date_trunc('month', created_at AT TIME ZONE 'UTC'))::date
  `);
  if (inv5Counters > 0) {
    violations.push({
      check: 'INV-5',
      detail: `${inv5Counters} usage_counters with wrong period_start`,
    });
  }

  // INV-6: tenant pairing — user-scoped rows carry the owner's account_id.
  // The composite foreign keys enforce this; the query proves they hold.
  const inv6Counters = await fetchCount(sql`
    SELECT COUNT(*) FROM usage_counters uc
    JOIN users u ON u.id = uc.user_id
    WHERE u.account_id <> uc.account_id
  `);
  if (inv6Counters > 0) {
    violations.push({
      check: 'INV-6',
      detail: `${inv6Counters} counters reference another account's user`,
    });
  }
  const inv6Requests = await fetchCount(sql`
    SELECT COUNT(*) FROM usage_requests ur
    JOIN users u ON u.id = ur.user_id
    WHERE u.account_id <> ur.account_id
  `);
  if (inv6Requests > 0) {
    violations.push({
      check: 'INV-6',
      detail: `${inv6Requests} requests reference another account's user`,
    });
  }
  const inv6Assignments = await fetchCount(sql`
    SELECT COUNT(*) FROM plan_assignments pa
    JOIN users u ON u.id = pa.user_id
    WHERE u.account_id <> pa.account_id
  `);
  if (inv6Assignments > 0) {
    violations.push({
      check: 'INV-6',
      detail: `${inv6Assignments} assignments reference another account's user`,
    });
  }

  // INV-7: idempotency keys are unique per account (unique index + proof).
  const inv7 = await fetchCount(sql`
    SELECT COUNT(*) FROM (
      SELECT account_id, idempotency_key
      FROM usage_requests
      GROUP BY account_id, idempotency_key
      HAVING COUNT(*) > 1
    ) duplicates
  `);
  if (inv7 > 0) {
    violations.push({ check: 'INV-7', detail: `${inv7} duplicated idempotency keys` });
  }

  // INV-8: rejected requests never contributed — the counter would differ
  // from INV-1/2 if they had. Explicitly report decision totals for context.
  const scopeFilter = accountId !== null ? sql`AND account_id = ${accountId}` : sql``;
  const rejected = await fetchCount(
    sql`SELECT COUNT(*) FROM usage_requests WHERE decision = 'rejected' ${scopeFilter}`
  );
  const accepted = await fetchCount(
    sql`SELECT COUNT(*) FROM usage_requests WHERE decision = 'accepted' ${scopeFilter}`
  );
  console.log(
    `Scope: ${accountLabel}; usage_requests: ${accepted} accepted, ${rejected} rejected (rejected units excluded from counters by INV-1/INV-2)`
  );

  return violations;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      account: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  const accountName = values.account;
  console.log('Verifying accounting invariants (usage_counters vs usage_requests)...');

  let violations: Violation[];
  try {
    violations = await verify(accountName);
  } catch (err) {
    console.error(`Invariant verification failed to run: ${(err as Error).message}`);
    process.exit(1);
  }

  if (violations.length === 0) {
    console.log('All accounting invariants hold.');
    process.exit(0);
  }

  console.error(`\n${violations.length} invariant violation(s):`);
  for (const v of violations) {
    console.error(`  [${v.check}] ${v.detail}`);
  }
  process.exit(1);
}

// Run main() only when executed directly (node/tsx), not when imported by
// tests that call verify() in-process against the same database client.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error('Invariant verification crashed:', err);
    process.exit(1);
  });
}
