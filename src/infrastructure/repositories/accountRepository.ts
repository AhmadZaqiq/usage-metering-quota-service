import type { Transaction } from "../../db/client.js";
import { sql, and, eq, isNull } from "drizzle-orm";
import { accounts } from "../../db/schema/index.js";

export interface AccountRow {
  id: bigint;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function mapRowToAccountRow(row: Record<string, unknown>): AccountRow {
  return {
    id: row.id as bigint,
    name: row.name as string,
    isActive: row.isActive as boolean,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
    deletedAt: row.deletedAt as Date | null,
  };
}

export async function selectAccountByName(
  tx: Transaction,
  name: string,
): Promise<AccountRow | null> {
  const result = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.name, name), isNull(accounts.deletedAt)))
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToAccountRow(result[0]);
}

export async function insertAccount(
  tx: Transaction,
  name: string,
): Promise<AccountRow> {
  const result = await tx
    .insert(accounts)
    .values({ name })
    .returning()
    .execute();

  return mapRowToAccountRow(result[0]);
}

/**
 * Take the period-independent admission lock: FOR UPDATE on the account row.
 * Returns false when the account does not exist (the caller decides the
 * error; authentication normally guarantees existence).
 *
 * Lock and clock must be two separate statements: in a single
 * `SELECT ..., clock_timestamp() ... FOR UPDATE` the target list can be
 * evaluated before LockRows acquires the lock, which would reintroduce a
 * pre-lock admission timestamp.
 */
export async function lockAccountForAdmission(
  tx: Transaction,
  accountId: bigint,
): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE
  `);
  return result.rows.length > 0;
}

/**
 * Current database clock as a UTC ISO-8601 string (millisecond precision).
 * Must be called only after the admission lock is held, so the timestamp
 * observes the moment the request is actually admitted, not the moment it
 * started waiting.
 */
export async function readClockTimestamp(tx: Transaction): Promise<string> {
  const result = await tx.execute(sql`
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts
  `);
  return String(result.rows[0].ts);
}
