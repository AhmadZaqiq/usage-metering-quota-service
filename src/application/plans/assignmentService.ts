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

  const now = new Date();
  const nextMonthStart = getNextUtcMonthStart(now);
  const nextMonthStartDate = new Date(nextMonthStart);

  // Determine whether this is an upgrade or downgrade by comparing the new
  // plan's monthly allowance against the currently effective plan's allowance.
  // Upgrades take effect immediately; downgrades take effect at the next UTC
  // month start so the current period keeps its existing allowance.
  let isDowngrade = false;

  if (isAccountLevel) {
    const current = await selectCurrentAssignmentByAccountForUpdate(
      tx,
      BigInt(accountId),
      now,
    );

    if (current) {
      const currentPlan = await selectPlanByCriteria(tx, current.planId);

      if (currentPlan && plan.monthlyAllowance < currentPlan.monthlyAllowance) {
        isDowngrade = true;
      }

      // End the current assignment:
      // - Downgrade: it stays effective until the next UTC month start.
      // - Upgrade / same tier: it ends when the new assignment starts.
      await updateAssignmentEffectiveTo(
        tx,
        current.id,
        isDowngrade ? nextMonthStartDate : effectiveFromDate,
      );
    }
  } else {
    const current = await selectCurrentAssignmentByUserForUpdate(tx, userId!, now);

    if (current) {
      const currentPlan = await selectPlanByCriteria(tx, current.planId);

      if (currentPlan && plan.monthlyAllowance < currentPlan.monthlyAllowance) {
        isDowngrade = true;
      }

      await updateAssignmentEffectiveTo(
        tx,
        current.id,
        isDowngrade ? nextMonthStartDate : effectiveFromDate,
      );
    }
  }

  // A downgrade is always scheduled for the next UTC month start, regardless
  // of any client-provided effectiveFrom. An upgrade starts immediately (or at
  // the client-provided effectiveFrom).
  const assignmentEffectiveFrom = isDowngrade ? nextMonthStartDate : effectiveFromDate;

  // Now check for overlaps with OTHER assignments (not the one we just ended)
  if (isAccountLevel) {
    const existing = await selectOverlappingAssignmentsByAccountForUpdate(
      tx,
      BigInt(accountId),
      assignmentEffectiveFrom,
    );

    if (existing.length > 0) {
      throw new ConflictError("Overlapping account-level assignment exists");
    }
  } else {
    const existing = await selectOverlappingAssignmentsByUserForUpdate(
      tx,
      userId!,
      assignmentEffectiveFrom,
    );

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
    assignmentEffectiveFrom,
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