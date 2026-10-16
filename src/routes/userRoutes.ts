import { Router, Response, Request } from "express";
import { db } from "../db/client.js";
import { users } from "../db/schema/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { asyncHandler } from "../utils/index.js";
import { createUserSchema } from "../validation/schemas.js";
import { ValidationError } from "../errors/AppError.js";
import { AuthenticatedRequest } from "../modules/auth/authMiddleware.js";

const router = Router();

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", parsed.error.flatten().fieldErrors);
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.accountId, BigInt(authReq.account.id)), eq(users.clientUserId, parsed.data.clientUserId), isNull(users.deletedAt)))
      .limit(1)
      .execute();

    if (existing.length > 0) {
      throw new ValidationError("User with this identifier already exists");
    }

    const [user] = await db
      .insert(users)
      .values({
        accountId: BigInt(authReq.account.id),
        clientUserId: parsed.data.clientUserId,
      })
      .returning({ id: users.id, clientUserId: users.clientUserId, createdAt: users.createdAt })
      .execute();

    return res.status(201).json({
      id: Number(user.id),
      clientUserId: user.clientUserId,
      createdAt: user.createdAt,
    });
  })
);

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userList = await db
      .select({ id: users.id, clientUserId: users.clientUserId, isActive: users.isActive, createdAt: users.createdAt })
      .from(users)
      .where(and(eq(users.accountId, BigInt(authReq.account.id)), isNull(users.deletedAt)))
      .execute();

    return res.json(userList.map((u) => ({
      id: Number(u.id),
      clientUserId: u.clientUserId,
      isActive: u.isActive,
      createdAt: u.createdAt,
    })));
  })
);

export default router;