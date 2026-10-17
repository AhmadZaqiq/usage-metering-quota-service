import { Router, Response, Request } from "express";
import { createUser, listUsers } from "../../application/users/userService.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { createUserSchema } from "../../validation/schemas.js";
import { ValidationError } from "../../errors/AppError.js";
import { AuthenticatedRequest } from "../middleware/authMiddleware.js";

const router = Router();

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", parsed.error.flatten().fieldErrors);
    }

    const user = await createUser(authReq.account.id, parsed.data.clientUserId);

    return res.status(201).json({
      id: user.id,
      clientUserId: user.clientUserId,
      createdAt: user.createdAt,
    });
  })
);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userList = await listUsers(authReq.account.id);

    return res.json(userList.map((u) => ({
      id: u.id,
      clientUserId: u.clientUserId,
      isActive: u.isActive,
      createdAt: u.createdAt,
    })));
  })
);

export default router;
