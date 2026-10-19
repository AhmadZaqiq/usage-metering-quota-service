import { z } from "zod";
import { MAX_UNITS_PER_REQUEST_BIGINT } from "../config/index.js";

export const usageRequestSchema = z
  .object({
    userId: z.string().min(1).max(255).optional(),
    units: z.string().regex(/^\d+$/).transform((v) => BigInt(v)).refine((v) => v > 0n && v <= MAX_UNITS_PER_REQUEST_BIGINT, {
      message: `Units must be between 1 and ${MAX_UNITS_PER_REQUEST_BIGINT}`,
    }),
    requestId: z.string().min(1).max(255).optional(),
    // Deprecated alias for requestId; accepted so existing clients keep working.
    idempotencyKey: z.string().min(1).max(255).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.requestId === undefined && data.idempotencyKey === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestId"],
        message: "requestId is required (idempotencyKey is accepted as a deprecated alias)",
      });
    }
    if (data.requestId !== undefined && data.idempotencyKey !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestId"],
        message: "Provide only one of requestId or idempotencyKey, not both",
      });
    }
  })
  .transform((data) => ({
    userId: data.userId,
    units: data.units,
    // superRefine guarantees exactly one key is present.
    idempotencyKey: (data.requestId ?? data.idempotencyKey)!,
  }));

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
  userId: z.string().min(1).max(255).optional(),
  planId: z.number().int().positive(),
  effectiveFrom: z.string().datetime().optional(),
});

export const createUserSchema = z.object({
  clientUserId: z.string().min(1).max(255),
});

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/).transform((v) => parseInt(v, 10)),
});

export const usageHistorySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Optional account-scoped subject filter; unknown users are a 404, not an empty page.
  userId: z.string().min(1).max(255).optional(),
});