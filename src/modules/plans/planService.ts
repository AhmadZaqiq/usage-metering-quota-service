import { db } from "../../db/client.js";
import { plans, accounts } from "../../db/schema/index.js";
import { eq, and, isNull, sql, or } from "drizzle-orm";
import { NotFoundError, AuthorizationError, ValidationError } from "../../errors/AppError.js";
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

  // If ownerAccountId is explicitly provided (including null), use it.
  // If not provided (undefined), default to requesting account (custom plan).
  const hasExplicitOwner = input.ownerAccountId !== undefined;
  const ownerAccountId = input.ownerAccountId ?? requestingAccountId;
  const isSystem = !hasExplicitOwner; // System plan only if explicitly set to null

  if (hasExplicitOwner && ownerAccountId !== null && ownerAccountId !== requestingAccountId) {
    throw new AuthorizationError("Cannot create custom plan for another account");
  }

  const [plan] = await db
    .insert(plans)
    .values({
      name: input.name,
      type: input.type,
      ownerAccountId: hasExplicitOwner ? (input.ownerAccountId === null ? null : BigInt(ownerAccountId)) : BigInt(requestingAccountId),
      monthlyAllowance: input.monthlyAllowance,
      maxUnitsPerRequest: input.maxUnitsPerRequest,
    })
    .returning()
    .execute();

  return mapPlan(plan);
}

export async function listPlans(requestingAccountId: number): Promise<PlanInfo[]> {
  const results = await db
    .select()
    .from(plans)
    .where(
      or(
        isNull(plans.ownerAccountId),
        and(eq(plans.ownerAccountId, BigInt(requestingAccountId)), isNull(plans.deletedAt))
      )
    )
    .execute();

  return results.map(mapPlan);
}

export async function getPlan(planId: number, requestingAccountId: number): Promise<PlanInfo> {
  const [plan] = await db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.id, BigInt(planId)),
        or(isNull(plans.ownerAccountId), eq(plans.ownerAccountId, BigInt(requestingAccountId))),
        isNull(plans.deletedAt)
      )
    )
    .limit(1)
    .execute();

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

export async function updatePlan(
  planId: number,
  input: UpdatePlanInput,
  requestingAccountId: number
): Promise<PlanInfo> {
  const plan = await getPlan(planId, requestingAccountId);

  if (plan.ownerAccountId && plan.ownerAccountId !== requestingAccountId) {
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

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.monthlyAllowance !== undefined) updates.monthlyAllowance = input.monthlyAllowance;
  if (input.maxUnitsPerRequest !== undefined) updates.maxUnitsPerRequest = input.maxUnitsPerRequest;
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  updates.updatedAt = new Date();

  const [updated] = await db
    .update(plans)
    .set(updates)
    .where(eq(plans.id, BigInt(planId)))
    .returning()
    .execute();

  return mapPlan(updated);
}

export async function deletePlan(planId: number, requestingAccountId: number): Promise<void> {
  const plan = await getPlan(planId, requestingAccountId);

  if (plan.ownerAccountId && plan.ownerAccountId !== requestingAccountId) {
    throw new AuthorizationError("Cannot delete plan owned by another account");
  }
  if (!plan.ownerAccountId) {
    throw new AuthorizationError("Cannot delete system plan");
  }

  await db
    .update(plans)
    .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(plans.id, BigInt(planId)))
    .execute();
}

function mapPlan(p: typeof plans.$inferSelect): PlanInfo {
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