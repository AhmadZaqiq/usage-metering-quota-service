import { db } from "../../db/client.js";
import { planAssignments, plans, users } from "../../db/schema/index.js";
import { eq, and, isNull, or, gte } from "drizzle-orm";
import { NotFoundError, AuthorizationError, ValidationError, ConflictError } from "../../errors/AppError.js";
import { getNextUtcMonthStart, formatDateForDb } from "../../utils/date.js";

export interface AssignmentInfo {
  id: number;
  accountId: number;
  userId: number | null;
  planId: number;
  planName: string;
  planType: "account" | "user";
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: Date;
  isCurrent: boolean;
}

export interface CreateAssignmentInput {
  userId?: string;
  planId: number;
  effectiveFrom?: Date;
}

export async function createAssignment(
  accountId: number,
  input: CreateAssignmentInput,
  requestingAccountId: number
): Promise<AssignmentInfo> {
  if (accountId !== requestingAccountId) {
    throw new AuthorizationError("Cannot create assignment for another account");
  }

  let userId: bigint | null = null;
  const isAccountLevel = !input.userId;

  if (!isAccountLevel) {
    const user = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.accountId, BigInt(accountId)), eq(users.clientUserId, input.userId!), isNull(users.deletedAt)))
      .limit(1)
      .execute();

    if (user.length === 0) {
      throw new NotFoundError("User not found in this account");
    }
    userId = user[0].id;
  }

  const [plan] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, BigInt(input.planId)), eq(plans.isActive, true), isNull(plans.deletedAt)))
    .limit(1)
    .execute();

  if (!plan) {
    throw new NotFoundError("Plan not found or inactive");
  }

  if (plan.ownerAccountId && Number(plan.ownerAccountId) !== accountId) {
    throw new AuthorizationError("Cannot assign custom plan from another account");
  }

  if (isAccountLevel && plan.type !== "account") {
    throw new ValidationError("Account-level assignment requires an account plan");
  }
  if (!isAccountLevel && plan.type !== "user") {
    throw new ValidationError("User-level assignment requires a user plan");
  }

  const effectiveFrom = input.effectiveFrom ?? new Date();
  const effectiveFromDate = new Date(effectiveFrom);

  const nextMonthStart = getNextUtcMonthStart(effectiveFromDate);
  const nextMonthStartDate = new Date(nextMonthStart);

  // First, end any current assignment for the same subject (account or user)
  // This must be done BEFORE checking for overlaps, so the old assignment doesn't appear as overlapping
  if (isAccountLevel) {
    const current = await db
      .select()
      .from(planAssignments)
      .where(and(eq(planAssignments.accountId, BigInt(accountId)), isNull(planAssignments.userId), isNull(planAssignments.effectiveTo)))
      .limit(1)
      .execute();

    if (current.length > 0) {
      await db
        .update(planAssignments)
        .set({ effectiveTo: nextMonthStartDate }) // End at start of next month
        .where(eq(planAssignments.id, current[0].id))
        .execute();
    }
  } else {
    const current = await db
      .select()
      .from(planAssignments)
      .where(and(eq(planAssignments.userId, userId!), isNull(planAssignments.effectiveTo)))
      .limit(1)
      .execute();

    if (current.length > 0) {
      await db
        .update(planAssignments)
        .set({ effectiveTo: nextMonthStartDate })
        .where(eq(planAssignments.id, current[0].id))
        .execute();
    }
  }

  // Now check for overlaps with OTHER assignments (not the one we just ended)
  if (isAccountLevel) {
    const existing = await db
      .select()
      .from(planAssignments)
      .where(
        and(
          eq(planAssignments.accountId, BigInt(accountId)),
          isNull(planAssignments.userId),
          or(isNull(planAssignments.effectiveTo), gte(planAssignments.effectiveTo, effectiveFromDate))
        )
      )
      .limit(1)
      .execute();

    if (existing.length > 0) {
      throw new ConflictError("Overlapping account-level assignment exists");
    }
  } else {
    const existing = await db
      .select()
      .from(planAssignments)
      .where(
        and(
          eq(planAssignments.userId, userId!),
          or(isNull(planAssignments.effectiveTo), gte(planAssignments.effectiveTo, effectiveFromDate))
        )
      )
      .limit(1)
      .execute();

    if (existing.length > 0) {
      throw new ConflictError("Overlapping user-level assignment exists");
    }
  }

  const finalEffectiveTo: Date | null = null;

  const [assignment] = await db
    .insert(planAssignments)
    .values({
      accountId: BigInt(accountId),
      userId,
      planId: BigInt(input.planId),
      effectiveFrom: effectiveFromDate,
      effectiveTo: finalEffectiveTo,
    })
    .returning()
    .execute();

  return mapAssignment(assignment, plan.name, plan.type as "account" | "user");
}

export async function listAssignments(accountId: number): Promise<AssignmentInfo[]> {
  const results = await db
    .select({
      id: planAssignments.id,
      accountId: planAssignments.accountId,
      userId: planAssignments.userId,
      planId: planAssignments.planId,
      effectiveFrom: planAssignments.effectiveFrom,
      effectiveTo: planAssignments.effectiveTo,
      createdAt: planAssignments.createdAt,
      planName: plans.name,
      planType: plans.type,
    })
    .from(planAssignments)
    .innerJoin(plans, eq(planAssignments.planId, plans.id))
    .where(eq(planAssignments.accountId, BigInt(accountId)))
    .execute();

  return results.map(mapAssignmentWithPlan);
}

export async function getCurrentAssignments(accountId: number): Promise<{
  account: AssignmentInfo | null;
  users: AssignmentInfo[];
}> {
  const results = await db
    .select({
      id: planAssignments.id,
      accountId: planAssignments.accountId,
      userId: planAssignments.userId,
      planId: planAssignments.planId,
      effectiveFrom: planAssignments.effectiveFrom,
      effectiveTo: planAssignments.effectiveTo,
      createdAt: planAssignments.createdAt,
      planName: plans.name,
      planType: plans.type,
    })
    .from(planAssignments)
    .innerJoin(plans, eq(planAssignments.planId, plans.id))
    .where(
      and(
        eq(planAssignments.accountId, BigInt(accountId)),
        isNull(planAssignments.effectiveTo)
      )
    )
    .execute();

  const account = results.find((r) => r.userId === null) ?? null;
  const users = results.filter((r) => r.userId !== null);

  return {
    account: account ? mapAssignmentWithPlan(account) : null,
    users: users.map(mapAssignmentWithPlan),
  };
}

function mapAssignment(a: typeof planAssignments.$inferSelect, planName: string, planType: "account" | "user"): AssignmentInfo {
  return {
    id: Number(a.id),
    accountId: Number(a.accountId),
    userId: a.userId ? Number(a.userId) : null,
    planId: Number(a.planId),
    planName,
    planType,
    effectiveFrom: formatDateForDb(a.effectiveFrom),
    effectiveTo: a.effectiveTo ? formatDateForDb(a.effectiveTo) : null,
    createdAt: a.createdAt,
    isCurrent: a.effectiveTo === null,
  };
}

function mapAssignmentWithPlan(r: {
  id: bigint;
  accountId: bigint;
  userId: bigint | null;
  planId: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  planName: string;
  planType: string;
}): AssignmentInfo {
  return {
    id: Number(r.id),
    accountId: Number(r.accountId),
    userId: r.userId ? Number(r.userId) : null,
    planId: Number(r.planId),
    planName: r.planName,
    planType: r.planType as "account" | "user",
    effectiveFrom: formatDateForDb(r.effectiveFrom),
    effectiveTo: r.effectiveTo ? formatDateForDb(r.effectiveTo) : null,
    createdAt: r.createdAt,
    isCurrent: r.effectiveTo === null,
  };
}