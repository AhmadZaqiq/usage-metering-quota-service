import { asyncHandler } from "../middleware/asyncHandler.js";
import { Router, Response } from "express";
import { getLiveness, getReadiness } from "../../application/health/healthService.js";

const router = Router();

router.get("/live", (_req, res: Response) => {
  return res.json(getLiveness());
});

router.get("/ready", asyncHandler(async (_req, res: Response) => {
  const readiness = await getReadiness();
  const statusCode = readiness.status === "ok" ? 200 : 503;
  return res.status(statusCode).json(readiness);
}));

export default router;