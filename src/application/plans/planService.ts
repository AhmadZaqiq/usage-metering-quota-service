import { db, withTransaction, type Transaction } from "../../db/client.js";
import {
  insertPlan,
  selectPlans,
  selectPlanById,
  selectPlanByIdForUpdate,
  updatePlan as updatePlanRow,
  softDeletePlan,
} from "../../infrastructure/repositories/planRepository.js";
import { selectPlanAssignmentUsage } from "../../infrastructure/repositories/assignmentRepository.js";
import { NotFoundError, AuthorizationError, ValidationError, ConflictError } from "../../errors/AppError.js";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../../config/index.js";

export interface PlanInfo {
  id: number;
  name: string;
  type: "account" | "user";
  ownerAccountId: number | null;
  monthlyAllowance: bigint;
  maxUnitsPerRequest: bigint;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  isSystem: boolean;
}

export interface CreatePlanInput {
  name: string;
  type: "account" | "user";
  monthlyAllowance: bigint;
  maxUnitsPerRequest: bigint;
  ownerAccountId?: number;
}

export async function createPlan(input: CreatePlanInput, requestingAccountId: number): Promise<PlanInfo> {
  if (input.monthlyAllowance <= 0n) {
    throw new ValidationError("Monthly allowance must be positive");
  }
  if (input.maxUnitsPerRequest <= 0n) {
    throw new ValidationError("Max units per request must be positive");
  }
  if (input.maxUnitsPerRequest > MAX_UNITS_PER_REQUEST_BIGINT) {
    throw new ValidationError(`Max units per request cannot exceed ${MAX_UNITS_PER_REQUEST_BIGINT}`);
  }

  const hasExplicitOwner = input.ownerAccountId !== undefined;
  const ownerAccountId = input.ownerAccountId ?? requestingAccountId;

  if (hasExplicitOwner && ownerAccountId !== null && ownerAccountId !== requestingAccountId) {
    throw new AuthorizationError("Cannot create custom plan for another account");
  }

  const plan = await insertPlan(
    db,
    input.name,
    input.type,
    hasExplicitOwner ? (input.ownerAccountId === null ? null : BigInt(ownerAccountId)) : BigInt(requestingAccountId),
    input.monthlyAllowance,
    input.maxUnitsPerRequest,
  );

  return mapPlan(plan);
}

export async function listPlans(requestingAccountId: number): Promise<PlanInfo[]> {
  const results = await selectPlans(db, BigInt(requestingAccountId));
  return results.map(mapPlan);
}

export async function getPlan(planId: number, requestingAccountId: number): Promise<PlanInfo> {
  const plan = await selectPlanById(db, BigInt(planId), BigInt(requestingAccountId));

  if (!plan) {
    throw new NotFoundError("Plan not found");
  }

  return mapPlan(plan);
}

export interface UpdatePlanInput {
  name?: string;
  monthlyAllowance?: bigint;
  maxUnitsPerRequest?: bigint;
  isActive?: boolean;
}

async function assertPlanNotAssigned(tx: Transaction, planId: bigint): Promise<void> {
  const usage = await selectPlanAssignmentUsage(tx, planId);

  if (usage.currentCount > 0 || usage.pendingCount > 0) {
    throw new ConflictError("Plan is assigned and cannot be deleted or deactivated");
  }
}

export async function updatePlan(
  planId: number,
  input: UpdatePlanInput,
  requestingAccountId: number
): Promise<PlanInfo> {
  return await withTransaction(async (tx) => {
    const plan = await selectPlanById(tx, BigInt(planId), BigInt(requestingAccountId));

    if (!plan) {
      throw new NotFoundError("Plan not found");
    }

    if (plan.ownerAccountId && plan.ownerAccountId !== BigInt(requestingAccountId)) {
      throw new AuthorizationError("Cannot modify plan owned by another account");
    }
    if (!plan.ownerAccountId) {
      throw new AuthorizationError("Cannot modify system plan");
    }

    if (input.monthlyAllowance !== undefined && input.monthlyAllowance <= 0n) {
      throw new ValidationError("Monthly allowance must be positive");
    }
    if (input.maxUnitsPerRequest !== undefined) {
      if (input.maxUnitsPerRequest <= 0n) {
        throw new ValidationError("Max units per request must be positive");
      }
      if (input.maxUnitsPerRequest > MAX_UNITS_PER_REQUEST_BIGINT) {
        throw new ValidationError(`Max units per request cannot exceed ${MAX_UNITS_PER_REQUEST_BIGINT}`);
      }
    }

    // Deactivating a plan that is still current or pending would leave usage
    // resolution without an effective plan. Require reassignment first.
    // Lock the plan row so a concurrent createAssignment cannot insert after
    // the not-assigned check. Under READ COMMITTED, a concurrent soft-delete
    // that commits while we wait makes selectPlanByIdForUpdate return null.
    if (input.isActive === false && plan.isActive) {
      const lockedPlan = await selectPlanByIdForUpdate(tx, BigInt(planId), BigInt(requestingAccountId));
      if (!lockedPlan) {
        throw new NotFoundError("Plan not found");
      }
      await assertPlanNotAssigned(tx, BigInt(planId));
    }

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.monthlyAllowance !== undefined) updates.monthlyAllowance = input.monthlyAllowance;
    if (input.maxUnitsPerRequest !== undefined) updates.maxUnitsPerRequest = input.maxUnitsPerRequest;
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    updates.updatedAt = new Date();

    const updated = await updatePlanRow(tx, BigInt(planId), updates);

    return mapPlan(updated);
  });
}

export async function deletePlan(planId: number, requestingAccountId: number): Promise<void> {
  return await withTransaction(async (tx) => {
    // Lock before the not-assigned check so concurrent createAssignment for
    // this plan cannot commit an assignment that we miss. If a concurrent
    // soft-delete already committed, the locked select re-evaluates and
    // returns null (READ COMMITTED).
    const plan = await selectPlanByIdForUpdate(tx, BigInt(planId), BigInt(requestingAccountId));

    if (!plan) {
      throw new NotFoundError("Plan not found");
    }

    if (plan.ownerAccountId && plan.ownerAccountId !== BigInt(requestingAccountId)) {
      throw new AuthorizationError("Cannot delete plan owned by another account");
    }
    if (!plan.ownerAccountId) {
      throw new AuthorizationError("Cannot delete system plan");
    }

    await assertPlanNotAssigned(tx, BigInt(planId));

    await softDeletePlan(tx, BigInt(planId));
  });
}

function mapPlan(p: { id: bigint; name: string; type: string; ownerAccountId: bigint | null; monthlyAllowance: bigint; maxUnitsPerRequest: bigint; isActive: boolean; createdAt: Date; updatedAt: Date; deletedAt: Date | null }): PlanInfo {
  return {
    id: Number(p.id),
    name: p.name,
    type: p.type as "account" | "user",
    ownerAccountId: p.ownerAccountId ? Number(p.ownerAccountId) : null,
    monthlyAllowance: p.monthlyAllowance,
    maxUnitsPerRequest: p.maxUnitsPerRequest,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    isSystem: p.ownerAccountId === null,
  };
}
