import type { Transaction } from "../../db/client.js";
import { and, eq, isNull } from "drizzle-orm";
import { users } from "../../db/schema/index.js";

export interface UserRow {
  id: bigint;
  accountId: bigint;
  clientUserId: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function mapRowToUserRow(row: Record<string, unknown>): UserRow {
  return {
    id: row.id as bigint,
    accountId: row.accountId as bigint,
    clientUserId: row.clientUserId as string,
    isActive: row.isActive as boolean,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
    deletedAt: row.deletedAt as Date | null,
  };
}

export async function selectUserByAccountAndClientUserId(
  tx: Transaction,
  accountId: bigint,
  clientUserId: string,
): Promise<UserRow | null> {
  const result = await tx
    .select()
    .from(users)
    .where(
      and(
        eq(users.accountId, accountId),
        eq(users.clientUserId, clientUserId),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToUserRow(result[0]);
}

export async function insertUser(
  tx: Transaction,
  accountId: bigint,
  clientUserId: string,
): Promise<UserRow> {
  const result = await tx
    .insert(users)
    .values({
      accountId,
      clientUserId,
    })
    .returning()
    .execute();

  return mapRowToUserRow(result[0]);
}

export async function selectUsersByAccount(
  tx: Transaction,
  accountId: bigint,
): Promise<UserRow[]> {
  const result = await tx
    .select()
    .from(users)
    .where(and(eq(users.accountId, accountId), isNull(users.deletedAt)))
    .execute();

  return result.map(mapRowToUserRow);
}
