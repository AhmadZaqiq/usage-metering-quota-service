import { sql } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";

export interface CounterRow {
  id: bigint;
  accountId: bigint;
  userId: bigint | null;
  periodStart: string;
  counter: bigint;
  createdAt: Date;
  updatedAt: Date;
}

function mapRowToCounterRow(row: Record<string, unknown>): CounterRow {
  return {
    id: row.id as bigint,
    accountId: row.accountId as bigint,
    userId: (row.userId as bigint | null) ?? null,
    periodStart: row.periodStart as string,
    counter: row.counter as bigint,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export async function upsertAndLockCounter(
  tx: Transaction,
  accountId: bigint,
  userId: bigint | null,
  periodStart: string
): Promise<CounterRow> {
  // Use raw SQL for upsert with partial unique indexes
  // Account-level: ON CONFLICT (account_id, period_start) WHERE user_id IS NULL
  // User-level: ON CONFLICT (account_id, user_id, period_start) WHERE user_id IS NOT NULL
  const conflictTarget = userId === null
    ? "account_id, period_start"
    : "account_id, user_id, period_start";
  
  const whereClause = userId === null
    ? "user_id IS NULL"
    : "user_id IS NOT NULL";

  const result = await tx.execute(sql`
    INSERT INTO usage_counters (account_id, user_id, period_start, counter)
    VALUES (${accountId}, ${userId}, ${periodStart}, 0)
    ON CONFLICT (${sql.raw(conflictTarget)}) WHERE ${sql.raw(whereClause)}
    DO UPDATE SET counter = usage_counters.counter
    RETURNING id, account_id as "accountId", user_id as "userId", period_start as "periodStart", counter, created_at as "createdAt", updated_at as "updatedAt"
  `);

  return mapRowToCounterRow(result.rows[0]);
}

export async function getCounterForUpdate(
  tx: Transaction,
  accountId: bigint,
  userId: bigint | null,
  periodStart: string
): Promise<CounterRow | null> {
  const result = await tx.execute(sql`
    SELECT id, account_id as "accountId", user_id as "userId", period_start as "periodStart", counter, created_at as "createdAt", updated_at as "updatedAt"
    FROM usage_counters
    WHERE account_id = ${accountId}
      AND period_start = ${periodStart}
      ${userId === null ? sql`AND user_id IS NULL` : sql`AND user_id = ${userId}`}
    LIMIT 1
  `);

  if (result.rows.length === 0) return null;
  return mapRowToCounterRow(result.rows[0]);
}

export async function incrementCounter(
  tx: Transaction,
  counterId: bigint,
  units: bigint
): Promise<void> {
  await tx.execute(sql`
    UPDATE usage_counters
    SET counter = counter + ${units}, updated_at = NOW()
    WHERE id = ${counterId}
  `);
}