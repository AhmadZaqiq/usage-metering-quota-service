import { withTransaction, type Transaction } from '../../db/client.js';
import {
  selectUserByAccountAndClientUserId,
  selectPlanByCriteriaForUpdate,
  selectCurrentAssignmentByAccountForUpdate,
  selectCurrentAssignmentByUserForUpdate,
  selectPendingAssignmentsByAccountForUpdate,
  selectPendingAssignmentsByUserForUpdate,
  selectOverlappingAssignmentsByAccountForUpdate,
  selectOverlappingAssignmentsByUserForUpdate,
  updateAssignmentEffectiveTo,
  insertAssignment,
} from '../../infrastructure/repositories/assignmentRepository.js';
import type { PlanAssignmentRow } from '../../infrastructure/repositories/assignmentRepository.js';
import { unwrapQueryError } from '../../domain/pgError.js';
import {
  NotFoundError,
  AuthorizationError,
  ValidationError,
  ConflictError,
} from '../../errors/AppError.js';

export interface AssignmentInfo {
  id: number;
  accountId: number;
  userId: number | null;
  planId: number;
  planName: string;
  planType: 'account' | 'user';
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
      const pgCode = (unwrapQueryError(err) as { code?: string }).code;
      if (pgCode === '23P01' || pgCode === '23505') {
        // no_overlapping_assignments exclusion constraint or
        // uq_current_account_assignment unique index violated
        throw new ConflictError('Overlapping assignment exists');
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
    throw new AuthorizationError('Cannot create assignment for another account');
  }

  let userId: bigint | null = null;
  const isAccountLevel = !input.userId;

  if (!isAccountLevel) {
    const user = await selectUserByAccountAndClientUserId(tx, BigInt(accountId), input.userId!);

    if (!user) {
      throw new NotFoundError('User not found in this account');
    }
    userId = user.id;
  }

  // Lock the target plan before any assignment mutation. Concurrent
  // delete/deactivate takes the same row lock, so one side waits and then
  // re-validates under READ COMMITTED (see selectPlanByCriteriaForUpdate).
  const plan = await selectPlanByCriteriaForUpdate(tx, BigInt(input.planId));

  if (!plan) {
    throw new NotFoundError('Plan not found or inactive');
  }

  if (plan.ownerAccountId && Number(plan.ownerAccountId) !== accountId) {
    throw new AuthorizationError('Cannot assign custom plan from another account');
  }

  if (isAccountLevel && plan.type !== 'account') {
    throw new ValidationError('Account-level assignment requires an account plan');
  }
  if (!isAccountLevel && plan.type !== 'user') {
    throw new ValidationError('User-level assignment requires a user plan');
  }

  const now = new Date();

  // Lock and load the full assignment timeline for this subject:
  // - current: effective right now
  // - pending: open-ended rows scheduled for the future (pending downgrades)
  let current: PlanAssignmentRow | null;
  let pending: PlanAssignmentRow[];

  if (isAccountLevel) {
    current = await selectCurrentAssignmentByAccountForUpdate(tx, BigInt(accountId), now);
    pending = await selectPendingAssignmentsByAccountForUpdate(tx, BigInt(accountId), now);
  } else {
    current = await selectCurrentAssignmentByUserForUpdate(tx, userId!, now);
    pending = await selectPendingAssignmentsByUserForUpdate(tx, userId!, now);
  }

  // BR-13: re-read the clock after the row locks above. Lock waits can last
  // for seconds under contention; stamping effectiveFrom with a pre-wait
  // timestamp would backdate an "immediate" change into the past.
  const nowAfterLocks = new Date();

  // Immediate plan-change semantics: when a current assignment exists, the
  // new assignment starts now (stamped after locks). The client-supplied
  // effectiveFrom is honored only for a subject's first assignment.
  const assignmentEffectiveFrom = current
    ? nowAfterLocks
    : new Date(input.effectiveFrom ?? nowAfterLocks);

  // Supersede any pending (future) assignments before inserting the new row.
  // Close each at its own effective_from (zero-width/empty range). That clears
  // the exclusion-constraint overlap without inventing a non-empty inverted
  // range, and preserves the audit row for the superseded request.
  for (const pendingRow of pending) {
    await updateAssignmentEffectiveTo(tx, pendingRow.id, pendingRow.effectiveFrom);
  }

  if (current) {
    // Close the current assignment exactly where the replacement begins, so
    // the half-open intervals form an unbroken chain with no overlap.
    await updateAssignmentEffectiveTo(tx, current.id, assignmentEffectiveFrom);
  }

  // Safety net: reject if another non-superseded assignment still overlaps.
  if (isAccountLevel) {
    const existing = await selectOverlappingAssignmentsByAccountForUpdate(
      tx,
      BigInt(accountId),
      assignmentEffectiveFrom
    );

    if (existing.length > 0) {
      throw new ConflictError('Overlapping account-level assignment exists');
    }
  } else {
    const existing = await selectOverlappingAssignmentsByUserForUpdate(
      tx,
      userId!,
      assignmentEffectiveFrom
    );

    if (existing.length > 0) {
      throw new ConflictError('Overlapping user-level assignment exists');
    }
  }

  const assignment = await insertAssignment(
    tx,
    BigInt(accountId),
    userId,
    BigInt(input.planId),
    assignmentEffectiveFrom,
    null
  );

  return mapAssignment(assignment, plan.name, plan.type as 'account' | 'user', nowAfterLocks);
}

function mapAssignment(
  a: {
    id: bigint;
    accountId: bigint;
    userId: bigint | null;
    planId: bigint;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    createdAt: Date;
  },
  planName: string,
  planType: 'account' | 'user',
  at: Date = new Date()
): AssignmentInfo {
  return {
    id: Number(a.id),
    accountId: Number(a.accountId),
    userId: a.userId ? Number(a.userId) : null,
    planId: Number(a.planId),
    planName,
    planType,
    // BR-14: full ISO-8601 instants, not date-only strings — effective_from
    // carries a time component (immediate upgrades stamp `now`) and clients
    // must be able to order intervals precisely.
    effectiveFrom: a.effectiveFrom.toISOString(),
    effectiveTo: a.effectiveTo ? a.effectiveTo.toISOString() : null,
    createdAt: a.createdAt,
    isCurrent: a.effectiveFrom <= at && (a.effectiveTo === null || a.effectiveTo > at),
  };
}
