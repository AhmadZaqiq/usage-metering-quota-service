import { Router, Response, Request } from "express";
import { processUsageRequest, getUsageHistory } from "../modules/usage/usageService.js";
import { withTransaction } from "../db/client.js";
import { usageRequestSchema, usageHistorySchema } from "../validation/schemas.js";
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

router.get("/", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const parsed = usageHistorySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ValidationError("Invalid query parameters", parsed.error.flatten().fieldErrors);
  }

  const { page, limit } = parsed.data;

  const result = await withTransaction(async (tx) => {
    return getUsageHistory(tx, BigInt(authReq.account.id), page, limit);
  });

  return res.json({
    items: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
    totalPages: result.totalPages,
  });
});

export default router;