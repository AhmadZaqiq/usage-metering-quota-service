import { sql } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";
import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { planAssignments, plans, users } from "../../db/schema/index.js";

export interface PlanAssignmentRow {
  id: bigint;
  accountId: bigint;
  userId: bigint | null;
  planId: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}

function mapRowToPlanAssignmentRow(row: Record<string, unknown>): PlanAssignmentRow {
  return {
    id: row.id as bigint,
    accountId: row.accountId as bigint,
    userId: row.userId as bigint | null,
    planId: row.planId as bigint,
    effectiveFrom: new Date(row.effectiveFrom as string | Date),
    effectiveTo: row.effectiveTo ? new Date(row.effectiveTo as string | Date) : null,
    createdAt: row.createdAt as Date,
  };
}

export async function selectUserByAccountAndClientUserId(
  tx: Transaction,
  accountId: bigint,
  clientUserId: string,
): Promise<{ id: bigint } | null> {
  const result = await tx
    .select({ id: users.id })
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
  return { id: result[0].id };
}

export interface PlanQuotaRow {
  id: bigint;
  name: string;
  type: string;
  ownerAccountId: bigint | null;
  monthlyAllowance: bigint;
  maxUnitsPerRequest: bigint;
}

export async function selectPlanByCriteria(
  tx: Transaction,
  planId: bigint,
): Promise<PlanQuotaRow | null> {
  const result = await tx
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.isActive, true), isNull(plans.deletedAt)))
    .limit(1)
    .execute();

  if (result.length === 0) return null;

  const plan = result[0];
  return {
    id: plan.id,
    name: plan.name,
    type: plan.type,
    ownerAccountId: plan.ownerAccountId,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
  };
}

// Locks the plan row under READ COMMITTED. Active/not-deleted predicates are
// part of the WHERE clause so PostgreSQL re-evaluates them after a concurrent
// updater commits (EvalPlanQual). Callers must not assume a plan locked here
// stays assignable without this re-check.
export async function selectPlanByCriteriaForUpdate(
  tx: Transaction,
  planId: bigint,
): Promise<PlanQuotaRow | null> {
  const result = await tx
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.isActive, true), isNull(plans.deletedAt)))
    .limit(1)
    .for("update")
    .execute();

  if (result.length === 0) return null;

  const plan = result[0];
  return {
    id: plan.id,
    name: plan.name,
    type: plan.type,
    ownerAccountId: plan.ownerAccountId,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
  };
}

export interface CurrentPlanQuotaRow {
  assignmentId: bigint;
  planId: bigint;
  monthlyAllowance: bigint;
  maxUnitsPerRequest: bigint;
}

/**
 * Resolve the account-scoped current assignment together with its plan quota
 * in one statement, for the usage hot path. The assignment-window predicates
 * are identical to selectCurrentAssignmentByAccount; the JOIN applies the
 * same active / not-deleted plan filter as selectPlanByCriteria. "No row"
 * covers both no-assignment and unusable-plan — the usage path fails closed
 * (409) on either, so the collapsed outcome is behaviour-preserving.
 */
export async function selectCurrentPlanQuotaByAccount(
  tx: Transaction,
  accountId: bigint,
  at: Date = new Date(),
): Promise<CurrentPlanQuotaRow | null> {
  const result = await tx.execute(sql`
    SELECT pa.id AS "assignmentId",
           p.id AS "planId",
           p.monthly_allowance AS "monthlyAllowance",
           p.max_units_per_request AS "maxUnitsPerRequest"
    FROM plan_assignments pa
    JOIN plans p ON p.id = pa.plan_id AND p.is_active AND p.deleted_at IS NULL
    WHERE pa.account_id = ${accountId} AND pa.user_id IS NULL
      AND pa.effective_from <= ${at}
      AND (pa.effective_to IS NULL OR pa.effective_to > ${at})
    ORDER BY pa.effective_from DESC
    LIMIT 1
  `);
  if (result.rows.length === 0) return null;
  return {
    assignmentId: BigInt(result.rows[0].assignmentId as string),
    planId: BigInt(result.rows[0].planId as string),
    monthlyAllowance: BigInt(result.rows[0].monthlyAllowance as string),
    maxUnitsPerRequest: BigInt(result.rows[0].maxUnitsPerRequest as string),
  };
}

/**
 * User-scoped twin of selectCurrentPlanQuotaByAccount for the usage hot path;
 * same predicates as selectCurrentAssignmentByUser plus the plan filter from
 * selectPlanByCriteria, in a single statement.
 */
export async function selectCurrentPlanQuotaByUser(
  tx: Transaction,
  userId: bigint,
  at: Date = new Date(),
): Promise<CurrentPlanQuotaRow | null> {
  const result = await tx.execute(sql`
    SELECT pa.id AS "assignmentId",
           p.id AS "planId",
           p.monthly_allowance AS "monthlyAllowance",
           p.max_units_per_request AS "maxUnitsPerRequest"
    FROM plan_assignments pa
    JOIN plans p ON p.id = pa.plan_id AND p.is_active AND p.deleted_at IS NULL
    WHERE pa.user_id = ${userId}
      AND pa.effective_from <= ${at}
      AND (pa.effective_to IS NULL OR pa.effective_to > ${at})
    ORDER BY pa.effective_from DESC
    LIMIT 1
  `);
  if (result.rows.length === 0) return null;
  return {
    assignmentId: BigInt(result.rows[0].assignmentId as string),
    planId: BigInt(result.rows[0].planId as string),
    monthlyAllowance: BigInt(result.rows[0].monthlyAllowance as string),
    maxUnitsPerRequest: BigInt(result.rows[0].maxUnitsPerRequest as string),
  };
}

export async function selectCurrentAssignmentByAccount(
  tx: Transaction,
  accountId: bigint,
  at: Date = new Date(),
): Promise<PlanAssignmentRow | null> {
  const result = await tx
    .select()
    .from(planAssignments)
    .where(
      and(
        eq(planAssignments.accountId, accountId),
        isNull(planAssignments.userId),
        lte(planAssignments.effectiveFrom, at),
        or(
          isNull(planAssignments.effectiveTo),
          gt(planAssignments.effectiveTo, at),
        ),
      ),
    )
    .orderBy(desc(planAssignments.effectiveFrom))
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanAssignmentRow(result[0]);
}

export async function selectCurrentAssignmentByAccountForUpdate(
  tx: Transaction,
  accountId: bigint,
  at: Date = new Date(),
): Promise<PlanAssignmentRow | null> {
  const result = await tx.execute(sql`
    SELECT id as "id", account_id as "accountId", user_id as "userId", plan_id as "planId",
           effective_from as "effectiveFrom", effective_to as "effectiveTo", created_at as "createdAt"
    FROM plan_assignments
    WHERE account_id = ${accountId} AND user_id IS NULL
      AND effective_from <= ${at}
      AND (effective_to IS NULL OR effective_to > ${at})
    ORDER BY effective_from DESC
    LIMIT 1
    FOR UPDATE
  `);

  if (result.rows.length === 0) return null;
  return mapRowToPlanAssignmentRow(result.rows[0]);
}

export async function selectCurrentAssignmentByUser(
  tx: Transaction,
  userId: bigint,
  at: Date = new Date(),
): Promise<PlanAssignmentRow | null> {
  const result = await tx
    .select()
    .from(planAssignments)
    .where(
      and(
        eq(planAssignments.userId, userId),
        lte(planAssignments.effectiveFrom, at),
        or(
          isNull(planAssignments.effectiveTo),
          gt(planAssignments.effectiveTo, at),
        ),
      ),
    )
    .orderBy(desc(planAssignments.effectiveFrom))
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanAssignmentRow(result[0]);
}

export async function selectCurrentAssignmentByUserForUpdate(
  tx: Transaction,
  userId: bigint,
  at: Date = new Date(),
): Promise<PlanAssignmentRow | null> {
  const result = await tx.execute(sql`
    SELECT id as "id", account_id as "accountId", user_id as "userId", plan_id as "planId",
           effective_from as "effectiveFrom", effective_to as "effectiveTo", created_at as "createdAt"
    FROM plan_assignments
    WHERE user_id = ${userId}
      AND effective_from <= ${at}
      AND (effective_to IS NULL OR effective_to > ${at})
    ORDER BY effective_from DESC
    LIMIT 1
    FOR UPDATE
  `);

  if (result.rows.length === 0) return null;
  return mapRowToPlanAssignmentRow(result.rows[0]);
}

export async function selectPendingAssignmentsByAccountForUpdate(
  tx: Transaction,
  accountId: bigint,
  at: Date = new Date(),
): Promise<PlanAssignmentRow[]> {
  const result = await tx.execute(sql`
    SELECT id as "id", account_id as "accountId", user_id as "userId", plan_id as "planId",
           effective_from as "effectiveFrom", effective_to as "effectiveTo", created_at as "createdAt"
    FROM plan_assignments
    WHERE account_id = ${accountId} AND user_id IS NULL
      AND effective_from > ${at}
      AND effective_to IS NULL
    ORDER BY effective_from ASC
    FOR UPDATE
  `);

  return result.rows.map(mapRowToPlanAssignmentRow);
}

export async function selectPendingAssignmentsByUserForUpdate(
  tx: Transaction,
  userId: bigint,
  at: Date = new Date(),
): Promise<PlanAssignmentRow[]> {
  const result = await tx.execute(sql`
    SELECT id as "id", account_id as "accountId", user_id as "userId", plan_id as "planId",
           effective_from as "effectiveFrom", effective_to as "effectiveTo", created_at as "createdAt"
    FROM plan_assignments
    WHERE user_id = ${userId}
      AND effective_from > ${at}
      AND effective_to IS NULL
    ORDER BY effective_from ASC
    FOR UPDATE
  `);

  return result.rows.map(mapRowToPlanAssignmentRow);
}

export async function selectPlanAssignmentUsage(
  tx: Transaction,
  planId: bigint,
): Promise<{ currentCount: number; pendingCount: number }> {
  const result = await tx.execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE effective_from <= now()
          AND (effective_to IS NULL OR effective_to > now())
      ) AS "currentCount",
      COUNT(*) FILTER (
        WHERE effective_from > now()
          AND effective_to IS NULL
      ) AS "pendingCount"
    FROM plan_assignments
    WHERE plan_id = ${planId}
  `);

  const row = result.rows[0] as { currentCount: string | number; pendingCount: string | number };
  return {
    currentCount: Number(row.currentCount),
    pendingCount: Number(row.pendingCount),
  };
}

export async function selectOverlappingAssignmentsByAccount(
  tx: Transaction,
  accountId: bigint,
  effectiveFrom: Date,
): Promise<PlanAssignmentRow[]> {
  const result = await tx
    .select()
    .from(planAssignments)
    .where(
      and(
        eq(planAssignments.accountId, accountId),
        isNull(planAssignments.userId),
        or(
          isNull(planAssignments.effectiveTo),
          and(
            gt(planAssignments.effectiveTo, planAssignments.effectiveFrom),
            gt(planAssignments.effectiveTo, effectiveFrom),
          ),
        ),
      ),
    )
    .limit(1)
    .execute();

  return result.map(mapRowToPlanAssignmentRow);
}

export async function selectOverlappingAssignmentsByAccountForUpdate(
  tx: Transaction,
  accountId: bigint,
  effectiveFrom: Date,
): Promise<PlanAssignmentRow[]> {
  const result = await tx.execute(sql`
    SELECT id, account_id, user_id, plan_id, effective_from, effective_to, created_at
    FROM plan_assignments
    WHERE account_id = ${accountId} AND user_id IS NULL
      AND (
        effective_to IS NULL
        OR (effective_to > effective_from AND effective_to > ${effectiveFrom})
      )
    LIMIT 1
    FOR UPDATE
  `);

  return result.rows.map(mapRowToPlanAssignmentRow);
}

export async function selectOverlappingAssignmentsByUser(
  tx: Transaction,
  userId: bigint,
  effectiveFrom: Date,
): Promise<PlanAssignmentRow[]> {
  const result = await tx
    .select()
    .from(planAssignments)
    .where(
      and(
        eq(planAssignments.userId, userId),
        or(
          isNull(planAssignments.effectiveTo),
          and(
            gt(planAssignments.effectiveTo, planAssignments.effectiveFrom),
            gt(planAssignments.effectiveTo, effectiveFrom),
          ),
        ),
      ),
    )
    .limit(1)
    .execute();

  return result.map(mapRowToPlanAssignmentRow);
}

export async function selectOverlappingAssignmentsByUserForUpdate(
  tx: Transaction,
  userId: bigint,
  effectiveFrom: Date,
): Promise<PlanAssignmentRow[]> {
  const result = await tx.execute(sql`
    SELECT id, account_id, user_id, plan_id, effective_from, effective_to, created_at
    FROM plan_assignments
    WHERE user_id = ${userId}
      AND (
        effective_to IS NULL
        OR (effective_to > effective_from AND effective_to > ${effectiveFrom})
      )
    LIMIT 1
    FOR UPDATE
  `);

  return result.rows.map(mapRowToPlanAssignmentRow);
}

export async function updateAssignmentEffectiveTo(
  tx: Transaction,
  assignmentId: bigint,
  effectiveTo: Date,
): Promise<void> {
  await tx
    .update(planAssignments)
    .set({ effectiveTo })
    .where(eq(planAssignments.id, assignmentId))
    .execute();
}

export async function insertAssignment(
  tx: Transaction,
  accountId: bigint,
  userId: bigint | null,
  planId: bigint,
  effectiveFrom: Date,
  effectiveTo: Date | null,
): Promise<PlanAssignmentRow> {
  const result = await tx
    .insert(planAssignments)
    .values({
      accountId,
      userId,
      planId,
      effectiveFrom,
      effectiveTo,
    })
    .returning()
    .execute();

  return mapRowToPlanAssignmentRow(result[0]);
}

export async function deleteAssignmentsByAccount(
  tx: Transaction,
  accountId: bigint,
): Promise<void> {
  await tx
    .delete(planAssignments)
    .where(and(eq(planAssignments.accountId, accountId), isNull(planAssignments.userId)))
    .execute();
}

export interface AssignmentWithPlanRow {
  id: bigint;
  accountId: bigint;
  userId: bigint | null;
  planId: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  planName: string;
  planType: string;
  isCurrent: boolean;
}

function mapRowToAssignmentWithPlan(row: Record<string, unknown>): AssignmentWithPlanRow {
  return {
    id: BigInt(row.id as string),
    accountId: BigInt(row.accountId as string),
    userId: row.userId ? BigInt(row.userId as string) : null,
    planId: BigInt(row.planId as string),
    effectiveFrom: new Date(row.effectiveFrom as string),
    effectiveTo: row.effectiveTo ? new Date(row.effectiveTo as string) : null,
    createdAt: new Date(row.createdAt as string),
    planName: row.planName as string,
    planType: row.planType as string,
    isCurrent: row.isCurrent as boolean,
  };
}

export async function listAssignmentsWithPlan(
  tx: Transaction,
  accountId: bigint,
): Promise<AssignmentWithPlanRow[]> {
  const result = await tx.execute(sql`
    SELECT plan_assignments.id as "id", plan_assignments.account_id as "accountId",
           plan_assignments.user_id as "userId", plan_assignments.plan_id as "planId",
           plan_assignments.effective_from as "effectiveFrom",
           plan_assignments.effective_to as "effectiveTo",
           plan_assignments.created_at as "createdAt",
           plans.name as "planName", plans.type as "planType",
           (plan_assignments.effective_from <= now() AND (plan_assignments.effective_to IS NULL OR plan_assignments.effective_to > now())) as "isCurrent"
    FROM plan_assignments
    INNER JOIN plans ON plan_assignments.plan_id = plans.id
    WHERE plan_assignments.account_id = ${accountId}
  `);

  return result.rows.map(mapRowToAssignmentWithPlan);
}

export async function getCurrentAssignmentsWithPlan(
  tx: Transaction,
  accountId: bigint,
  at: Date = new Date(),
): Promise<AssignmentWithPlanRow[]> {
  const result = await tx.execute(sql`
    SELECT plan_assignments.id as "id", plan_assignments.account_id as "accountId",
           plan_assignments.user_id as "userId", plan_assignments.plan_id as "planId",
           plan_assignments.effective_from as "effectiveFrom",
           plan_assignments.effective_to as "effectiveTo",
           plan_assignments.created_at as "createdAt",
           plans.name as "planName", plans.type as "planType",
           (plan_assignments.effective_from <= ${at} AND (plan_assignments.effective_to IS NULL OR plan_assignments.effective_to > ${at})) as "isCurrent"
    FROM plan_assignments
    INNER JOIN plans ON plan_assignments.plan_id = plans.id
    WHERE plan_assignments.account_id = ${accountId}
      AND plan_assignments.effective_from <= ${at}
      AND (plan_assignments.effective_to IS NULL OR plan_assignments.effective_to > ${at})
    ORDER BY plan_assignments.effective_from DESC
  `);

  return result.rows.map(mapRowToAssignmentWithPlan);
}
