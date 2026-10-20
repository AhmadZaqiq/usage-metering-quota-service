import { Router, Response, Request } from "express";
import { processUsageRequest } from "../../application/usage/usageService.js";
import { getUsageHistory } from "../../application/usage/usageHistoryService.js";
import { getUsageSummary, parsePeriodStart } from "../../application/usage/usageSummaryService.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { usageRequestSchema, usageHistorySchema, usageSummarySchema } from "../../validation/schemas.js";
import { AuthenticatedRequest } from "../middleware/authMiddleware.js";
import { ValidationError } from "../../errors/AppError.js";

const router = Router();

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
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
    // Only present when the rejection was a per-request-cap breach, and only on
    // a live evaluation (not an idempotent replay of a stored decision).
    if (result.limitScope !== undefined) {
      response.limitScope = result.limitScope;
    }

    return res.json(response);
  })
);

router.get(
  "/summary",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const parsed = usageSummarySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.flatten().fieldErrors);
    }

    const periodStart = parsePeriodStart(parsed.data.periodStart);
    const summary = await getUsageSummary(authReq.account.id, periodStart, parsed.data.userId);

    return res.json(summary);
  })
);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const parsed = usageHistorySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.flatten().fieldErrors);
    }

    const { page, limit, userId } = parsed.data;

    const result = await getUsageHistory(BigInt(authReq.account.id), page, limit, userId);

    return res.json({
      items: result.items,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  })
);

export default router;