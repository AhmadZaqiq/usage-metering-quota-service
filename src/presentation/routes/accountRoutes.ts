import { Router, Response, Request } from "express";
import { provisionAccount } from "../../application/accounts/accountProvisioningService.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createAccountSchema } from "../../validation/schemas.js";
import { ValidationError } from "../../errors/AppError.js";

const router = Router();

// Mounted behind operatorAuthMiddleware (see src/app.ts): the operator
// credential is a shared token from the environment, never a tenant API key.
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = createAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", parsed.error.flatten().fieldErrors);
    }

    const result = await provisionAccount(parsed.data);
    return res.status(201).json(result);
  }),
);

export default router;
