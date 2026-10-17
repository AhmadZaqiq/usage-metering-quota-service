import { withTransaction, type Transaction } from "../../db/client.js";
import {
  selectUserByAccountAndClientUserId,
  selectPlanByCriteria,
  selectCurrentAssignmentByAccountForUpdate,
  selectCurrentAssignmentByUserForUpdate,
  selectOverlappingAssignmentsByAccountForUpdate,
  selectOverlappingAssignmentsByUserForUpdate,
  updateAssignmentEffectiveTo,
  insertAssignment,
} from "../../infrastructure/repositories/assignmentRepository.js";
import { NotFoundError, AuthorizationError, ValidationError, ConflictError } from "../../errors/AppError.js";
import { getNextUtcMonthStart, formatDateForDb } from "../../domain/date.js";

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
  return withTransaction(async (tx) => {
    try {
      return await createAssignmentImpl(tx, accountId, input, requestingAccountId);
    } catch (err) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === "23P01" || pgCode === "23505") {
        // no_overlapping_assignments exclusion constraint or
        // uq_current_account_assignment unique index violated
        throw new ConflictError("Overlapping assignment exists");
      }
      throw err;
    }
  });
}

async function createAssignmentImpl(
  tx: Transaction,
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
    const user = await selectUserByAccountAndClientUserId(tx, BigInt(accountId), input.userId!);

    if (!user) {
      throw new NotFoundError("User not found in this account");
    }
    userId = user.id;
  }

  const plan = await selectPlanByCriteria(tx, BigInt(input.planId));

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
    const current = await selectCurrentAssignmentByAccountForUpdate(tx, BigInt(accountId));

    if (current) {
      await updateAssignmentEffectiveTo(tx, current.id, nextMonthStartDate);
    }
  } else {
    const current = await selectCurrentAssignmentByUserForUpdate(tx, userId!);

    if (current) {
      await updateAssignmentEffectiveTo(tx, current.id, nextMonthStartDate);
    }
  }

  // Now check for overlaps with OTHER assignments (not the one we just ended)
  if (isAccountLevel) {
    const existing = await selectOverlappingAssignmentsByAccountForUpdate(tx, BigInt(accountId), effectiveFromDate);

    if (existing.length > 0) {
      throw new ConflictError("Overlapping account-level assignment exists");
    }
  } else {
    const existing = await selectOverlappingAssignmentsByUserForUpdate(tx, userId!, effectiveFromDate);

    if (existing.length > 0) {
      throw new ConflictError("Overlapping user-level assignment exists");
    }
  }

  const finalEffectiveTo: Date | null = null;

  const assignment = await insertAssignment(
    tx,
    BigInt(accountId),
    userId,
    BigInt(input.planId),
    effectiveFromDate,
    finalEffectiveTo,
  );

  return mapAssignment(assignment, plan.name, plan.type as "account" | "user");
}

function mapAssignment(a: { id: bigint; accountId: bigint; userId: bigint | null; planId: bigint; effectiveFrom: Date; effectiveTo: Date | null; createdAt: Date }, planName: string, planType: "account" | "user"): AssignmentInfo {
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