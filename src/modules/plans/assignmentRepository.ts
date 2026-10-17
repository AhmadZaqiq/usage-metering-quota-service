import { sql } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";
import { and, eq, isNull, or, gte } from "drizzle-orm";
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
    effectiveFrom: row.effectiveFrom as Date,
    effectiveTo: row.effectiveTo as Date | null,
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

export async function selectCurrentAssignmentByAccount(
  tx: Transaction,
  accountId: bigint,
): Promise<PlanAssignmentRow | null> {
  const result = await tx
    .select()
    .from(planAssignments)
    .where(
      and(
        eq(planAssignments.accountId, accountId),
        isNull(planAssignments.userId),
        isNull(planAssignments.effectiveTo),
      ),
    )
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanAssignmentRow(result[0]);
}

export async function selectCurrentAssignmentByAccountForUpdate(
  tx: Transaction,
  accountId: bigint,
): Promise<PlanAssignmentRow | null> {
  const result = await tx.execute(sql`
    SELECT id, account_id, user_id, plan_id, effective_from, effective_to, created_at
    FROM plan_assignments
    WHERE account_id = ${accountId} AND user_id IS NULL AND effective_to IS NULL
    LIMIT 1
    FOR UPDATE
  `);

  if (result.rows.length === 0) return null;
  return mapRowToPlanAssignmentRow(result.rows[0]);
}

export async function selectCurrentAssignmentByUser(
  tx: Transaction,
  userId: bigint,
): Promise<PlanAssignmentRow | null> {
  const result = await tx
    .select()
    .from(planAssignments)
    .where(and(eq(planAssignments.userId, userId), isNull(planAssignments.effectiveTo)))
    .limit(1)
    .execute();

  if (result.length === 0) return null;
  return mapRowToPlanAssignmentRow(result[0]);
}

export async function selectCurrentAssignmentByUserForUpdate(
  tx: Transaction,
  userId: bigint,
): Promise<PlanAssignmentRow | null> {
  const result = await tx.execute(sql`
    SELECT id, account_id, user_id, plan_id, effective_from, effective_to, created_at
    FROM plan_assignments
    WHERE user_id = ${userId} AND effective_to IS NULL
    LIMIT 1
    FOR UPDATE
  `);

  if (result.rows.length === 0) return null;
  return mapRowToPlanAssignmentRow(result.rows[0]);
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
          gte(planAssignments.effectiveTo, effectiveFrom),
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
      AND (effective_to IS NULL OR effective_to >= ${effectiveFrom})
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
          gte(planAssignments.effectiveTo, effectiveFrom),
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
      AND (effective_to IS NULL OR effective_to >= ${effectiveFrom})
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
}

function mapRowToAssignmentWithPlan(row: Record<string, unknown>): AssignmentWithPlanRow {
  return {
    id: row.id as bigint,
    accountId: row.accountId as bigint,
    userId: row.userId as bigint | null,
    planId: row.planId as bigint,
    effectiveFrom: row.effectiveFrom as Date,
    effectiveTo: row.effectiveTo as Date | null,
    createdAt: row.createdAt as Date,
    planName: row.planName as string,
    planType: row.planType as string,
  };
}

export async function listAssignmentsWithPlan(
  tx: Transaction,
  accountId: bigint,
): Promise<AssignmentWithPlanRow[]> {
  const result = await tx.execute(sql`
    SELECT plan_assignments.id, plan_assignments.account_id, plan_assignments.user_id,
           plan_assignments.plan_id, plan_assignments.effective_from, plan_assignments.effective_to,
           plan_assignments.created_at, plans.name as plan_name, plans.type as plan_type
    FROM plan_assignments
    INNER JOIN plans ON plan_assignments.plan_id = plans.id
    WHERE plan_assignments.account_id = ${accountId}
  `);

  return result.rows.map(mapRowToAssignmentWithPlan);
}

export async function getCurrentAssignmentsWithPlan(
  tx: Transaction,
  accountId: bigint,
): Promise<AssignmentWithPlanRow[]> {
  const result = await tx.execute(sql`
    SELECT plan_assignments.id, plan_assignments.account_id, plan_assignments.user_id,
           plan_assignments.plan_id, plan_assignments.effective_from, plan_assignments.effective_to,
           plan_assignments.created_at, plans.name as plan_name, plans.type as plan_type
    FROM plan_assignments
    INNER JOIN plans ON plan_assignments.plan_id = plans.id
    WHERE plan_assignments.account_id = ${accountId} AND plan_assignments.effective_to IS NULL
  `);

  return result.rows.map(mapRowToAssignmentWithPlan);
}
