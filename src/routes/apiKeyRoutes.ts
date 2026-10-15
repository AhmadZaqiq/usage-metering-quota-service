import { Router, Response, Request } from "express";
import { createApiKey, listApiKeys, revokeApiKey } from "../modules/auth/apiKeyService.js";
import { createApiKeySchema, idParamSchema } from "../validation/schemas.js";
import { AuthenticatedRequest } from "../modules/auth/authMiddleware.js";
import { ValidationError } from "../errors/AppError.js";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const parsed = createApiKeySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", parsed.error.flatten().fieldErrors);
  }

  const result = await createApiKey(authReq.account!.id, parsed.data.name);
  return res.status(201).json({
    id: result.id,
    prefix: result.prefix,
    key: result.key,
    name: result.name,
  });
});

router.get("/", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const keys = await listApiKeys(authReq.account!.id);
  return res.json(keys);
});

router.delete("/:id", async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new ValidationError("Invalid ID", parsed.error.flatten().fieldErrors);
  }

  await revokeApiKey(authReq.account!.id, parsed.data.id);
  return res.status(204).send();
});

export default router;