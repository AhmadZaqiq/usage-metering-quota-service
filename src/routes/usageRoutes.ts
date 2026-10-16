import { Router, Response, Request } from "express";
import { processUsageRequest } from "../modules/usage/usageService.js";
import { usageRequestSchema } from "../validation/schemas.js";
import { AuthenticatedRequest } from "../modules/auth/authMiddleware.js";
import { ValidationError } from "../errors/AppError.js";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const parsed = usageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", parsed.error.flatten().fieldErrors);
  }

  const result = await processUsageRequest(authReq.account.id, parsed.data, authReq.apiKeyId);

  const response: Record<string, unknown> = {
    decision: result.decision,
    accountRemaining: result.accountRemaining.toString(),
    periodStart: result.periodStart,
  };

  if (result.userRemaining !== undefined) {
    response.userRemaining = result.userRemaining.toString();
  }
  if (result.rejectionReason) {
    response.rejectionReason = result.rejectionReason;
  }

  return res.json(response);
});

export default router;