import { sql } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";
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
  const result = await tx.execute(sql`
    SELECT id, name, is_active, created_at, updated_at, deleted_at
    FROM accounts
    WHERE name = ${name}
    LIMIT 1
  `);

  if (result.rows.length === 0) return null;
  return mapRowToAccountRow(result.rows[0]);
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

export async function selectAccountById(
  tx: Transaction,
  accountId: bigint,
): Promise<AccountRow | null> {
  const result = await tx.execute(sql`
    SELECT id, name, is_active, created_at, updated_at, deleted_at
    FROM accounts
    WHERE id = ${accountId} AND deleted_at IS NULL
    LIMIT 1
  `);

  if (result.rows.length === 0) return null;
  return mapRowToAccountRow(result.rows[0]);
}
