import type { Transaction } from "../../db/client.js";
import { and, eq, isNull, or } from "drizzle-orm";
import { plans } from "../../db/schema/index.js";

export interface PlanRow {
  id: bigint;
  name: string;
  type: string;
  ownerAccountId: bigint | null;
  monthlyAllowance: bigint;
  maxUnitsPerRequest: bigint;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function mapRowToPlanRow(row: Record<string, unknown>): PlanRow {
  return {
    id: row.id as bigint,
    name: row.name as string,
    type: row.type as string,
    ownerAccountId: row.ownerAccountId as bigint | null,
    monthlyAllowance: row.monthlyAllowance as bigint,
    maxUnitsPerRequest: row.maxUnitsPerRequest as bigint,
    isActive: row.isActive as boolean,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
    deletedAt: row.deletedAt as Date | null,
  };
}

export async function insertPlan(
  tx: Transaction,
  name: string,
  type: string,
  ownerAccountId: bigint | null,
  monthlyAllowance: bigint,
  maxUnitsPerRequest: bigint,
): Promise<PlanRow> {
  const result = await tx
    .insert(plans)
    .values({
      name,
      type,
      ownerAccountId,
      monthlyAllowance,
      maxUnitsPerRequest,
    })
    .returning()
    .execute();

  return mapRowToPlanRow(result[0]);
}

export async function selectPlans(
  tx: Transaction,
  accountId: bigint,
): Promise<PlanRow[]> {
  const result = await tx
    .select()
    .from(plans)
    .where(
      or(
        isNull(plans.ownerAccountId),
        and(eq(plans.ownerAccountId, accountId), isNull(plans.deletedAt)),
      ),
    )
    .execute();

  return result.map(mapRowToPlanRow);
}

export async function selectPlanById(
  tx: Transaction,
  planId: bigint,
  accountId: bigint,
): Promise<PlanRow | null> {
  const result = await tx
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.id, planId),
        or(isNull(plans.ownerAccountId), eq(plans.ownerAccountId, accountId)),
        isNull(plans.deletedAt),
      ),
    )
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanRow(result[0]);
}

// Locks the plan row under READ COMMITTED. The not-deleted predicate is part
// of the WHERE clause so a concurrent soft-delete is re-evaluated after FOR
// UPDATE waits (EvalPlanQual). Returns null if the plan was deleted while
// waiting, so callers cannot proceed on a stale row.
export async function selectPlanByIdForUpdate(
  tx: Transaction,
  planId: bigint,
  accountId: bigint,
): Promise<PlanRow | null> {
  const result = await tx
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.id, planId),
        or(isNull(plans.ownerAccountId), eq(plans.ownerAccountId, accountId)),
        isNull(plans.deletedAt),
      ),
    )
    .limit(1)
    .for("update")
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanRow(result[0]);
}

export async function selectPlanByAccountAndName(
  tx: Transaction,
  accountId: bigint,
  name: string,
): Promise<PlanRow | null> {
  const result = await tx
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.ownerAccountId, accountId),
        eq(plans.name, name),
        isNull(plans.deletedAt),
      ),
    )
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanRow(result[0]);
}

// Predefined (system) plans have no owner and are shared by every account.
export async function selectSystemPlanByTypeAndName(
  tx: Transaction,
  type: string,
  name: string,
): Promise<PlanRow | null> {
  const result = await tx
    .select()
    .from(plans)
    .where(
      and(
        isNull(plans.ownerAccountId),
        eq(plans.type, type),
        eq(plans.name, name),
        isNull(plans.deletedAt),
      ),
    )
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanRow(result[0]);
}

// CON-03: the not-deleted predicate is part of the WHERE clause so a
// concurrent soft-delete that commits while we wait is re-evaluated under
// READ COMMITTED (EvalPlanQual) instead of being silently overwritten.
// Returns null when the row is gone or deleted, so callers fail with 404.
export async function updatePlan(
  tx: Transaction,
  planId: bigint,
  updates: Record<string, unknown>,
): Promise<PlanRow | null> {
  const result = await tx
    .update(plans)
    .set(updates)
    .where(and(eq(plans.id, planId), isNull(plans.deletedAt)))
    .returning()
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanRow(result[0]);
}

export async function softDeletePlan(
  tx: Transaction,
  planId: bigint,
): Promise<void> {
  await tx
    .update(plans)
    .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(plans.id, planId))
    .execute();
}
