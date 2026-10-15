import { Router, Response, Request } from "express";
import { createAssignment, listAssignments, getCurrentAssignments } from "../modules/plans/assignmentService.js";
import { createAssignmentSchema } from "../validation/schemas.js";
import { AuthenticatedRequest } from "../modules/auth/authMiddleware.js";
import { ValidationError } from "../errors/AppError.js";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const parsed = createAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", parsed.error.flatten().fieldErrors);
  }

  // Convert effectiveFrom string to Date if provided
  const input = {
    ...parsed.data,
    effectiveFrom: parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : undefined,
  };

  const assignment = await createAssignment(authReq.account!.id, input, authReq.account!.id);
  return res.status(201).json(assignment);
});

router.get("/", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const assignments = await listAssignments(authReq.account!.id);
  return res.json(assignments);
});

router.get("/current", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const current = await getCurrentAssignments(authReq.account!.id);
  return res.json(current);
});

export default router;