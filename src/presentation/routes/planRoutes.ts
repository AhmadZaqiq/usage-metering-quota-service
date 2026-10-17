import { Router, Response, Request } from "express";
import { createPlan, listPlans, getPlan, updatePlan, deletePlan } from "../../application/plans/planService.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createPlanSchema, updatePlanSchema, idParamSchema } from "../../validation/schemas.js";
import { AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { ValidationError } from "../../errors/AppError.js";

const router = Router();

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const parsed = createPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", parsed.error.flatten().fieldErrors);
    }

    const plan = await createPlan(parsed.data, authReq.account.id);
    return res.status(201).json({
      id: plan.id,
      name: plan.name,
      type: plan.type,
      ownerAccountId: plan.ownerAccountId,
      monthlyAllowance: plan.monthlyAllowance.toString(),
      maxUnitsPerRequest: plan.maxUnitsPerRequest.toString(),
      isActive: plan.isActive,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    });
  })
);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const plans = await listPlans(authReq.account.id);
    return res.json(
      plans.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        ownerAccountId: p.ownerAccountId,
        monthlyAllowance: p.monthlyAllowance.toString(),
        maxUnitsPerRequest: p.maxUnitsPerRequest.toString(),
        isActive: p.isActive,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }))
    );
  })
);

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw new ValidationError("Invalid ID", parsed.error.flatten().fieldErrors);
    }

    const plan = await getPlan(parsed.data.id, authReq.account.id);
    return res.json({
      id: plan.id,
      name: plan.name,
      type: plan.type,
      ownerAccountId: plan.ownerAccountId,
      monthlyAllowance: plan.monthlyAllowance.toString(),
      maxUnitsPerRequest: plan.maxUnitsPerRequest.toString(),
      isActive: plan.isActive,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    });
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const paramParsed = idParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      throw new ValidationError("Invalid ID", paramParsed.error.flatten().fieldErrors);
    }

    const bodyParsed = updatePlanSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      throw new ValidationError("Invalid request body", bodyParsed.error.flatten().fieldErrors);
    }

    const plan = await updatePlan(paramParsed.data.id, bodyParsed.data, authReq.account.id);
    return res.json({
      id: plan.id,
      name: plan.name,
      type: plan.type,
      ownerAccountId: plan.ownerAccountId,
      monthlyAllowance: plan.monthlyAllowance.toString(),
      maxUnitsPerRequest: plan.maxUnitsPerRequest.toString(),
      isActive: plan.isActive,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      throw new ValidationError("Invalid ID", parsed.error.flatten().fieldErrors);
    }

    await deletePlan(parsed.data.id, authReq.account.id);
    return res.status(204).send();
  })
);

export default router;