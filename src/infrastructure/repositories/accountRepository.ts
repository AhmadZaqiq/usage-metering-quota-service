import type { Transaction } from "../../db/client.js";
import { and, eq, isNull } from "drizzle-orm";
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
