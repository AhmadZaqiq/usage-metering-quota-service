import { z } from "zod";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../config/index.js";

export const usageRequestSchema = z.object({
  userId: z.string().max(255).optional(),
  units: z.string().regex(/^\d+$/).transform((v) => BigInt(v)).refine((v) => v > 0n && v <= MAX_UNITS_PER_REQUEST_BIGINT, {
    message: `Units must be between 1 and ${MAX_UNITS_PER_REQUEST_BIGINT}`,
  }),
  idempotencyKey: z.string().min(1).max(255),
});

export const createApiKeySchema = z.object({
  name: z.string().max(100).optional(),
});

export const createPlanSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["account", "user"]),
  monthlyAllowance: z.string().regex(/^\d+$/).transform((v) => BigInt(v)).refine((v) => v > 0n),
  maxUnitsPerRequest: z.string().regex(/^\d+$/).transform((v) => BigInt(v)).refine((v) => v > 0n && v <= MAX_UNITS_PER_REQUEST_BIGINT),
});

export const updatePlanSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  monthlyAllowance: z.string().regex(/^\d+$/).transform((v) => BigInt(v)).refine((v) => v > 0n).optional(),
  maxUnitsPerRequest: z.string().regex(/^\d+$/).transform((v) => BigInt(v)).refine((v) => v > 0n && v <= MAX_UNITS_PER_REQUEST_BIGINT).optional(),
  isActive: z.boolean().optional(),
});

export const createAssignmentSchema = z.object({
  userId: z.string().max(255).optional(),
  planId: z.number().int().positive(),
  effectiveFrom: z.string().datetime().optional(),
});

export const createUserSchema = z.object({
  clientUserId: z.string().min(1).max(255),
});

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)),
});