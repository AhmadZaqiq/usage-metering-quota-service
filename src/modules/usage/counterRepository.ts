import { db } from "../../db/client.js";
import { usageCounters } from "../../db/schema/usageCounters.js";
import { eq, and, sql } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";

export interface CounterRow {
  id: bigint;
  accountId: bigint;
  userId: bigint;
  periodStart: string;
  counter: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export async function upsertAndLockCounter(
  tx: Transaction,
  accountId: bigint,
  userId: bigint,
  periodStart: string
): Promise<CounterRow> {
  const [counter] = await tx
    .insert(usageCounters)
    .values({
      accountId,
      userId,
      periodStart,
      counter: 0n,
    })
    .onConflictDoUpdate({
      target: [usageCounters.accountId, usageCounters.userId, usageCounters.periodStart],
      set: { counter: usageCounters.counter as any },
    })
    .returning()
    .execute();

  return counter! as CounterRow;
}

export async function getCounterForUpdate(
  tx: Transaction,
  accountId: bigint,
  userId: bigint,
  periodStart: string
): Promise<CounterRow | null> {
  const [counter] = await tx
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.accountId, accountId),
        eq(usageCounters.userId, userId),
        eq(usageCounters.periodStart, periodStart)
      )
    )
    .limit(1)
    .execute();

  return (counter as CounterRow) ?? null;
}

export async function incrementCounter(
  tx: Transaction,
  counterId: bigint,
  units: bigint
): Promise<void> {
  await tx
    .update(usageCounters)
    .set({
      counter: sql`${usageCounters.counter} + ${units}`,
      updatedAt: new Date(),
    })
    .where(eq(usageCounters.id, counterId))
    .execute();
}