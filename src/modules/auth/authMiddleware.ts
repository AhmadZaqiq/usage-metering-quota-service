import { Request, Response, NextFunction } from "express";
import { verifyApiKey } from "./apiKeyService.js";
import { AuthenticationError, AuthorizationError } from "../../errors/AppError.js";

export interface AuthenticatedRequest extends Request {
  account: { id: number };
  apiKeyId: number;
}

declare global {
  namespace Express {
    interface Request {
      account?: { id: number };
      apiKeyId?: number;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthenticationError("Missing or invalid Authorization header");
  }

  const apiKey = authHeader.slice(7);

  const verified = await verifyApiKey(apiKey);

  if (!verified) {
    throw new AuthenticationError("Invalid or revoked API key");
  }

  req.account = { id: verified.accountId };
  req.apiKeyId = verified.apiKeyId;

  next();
}

export function requireAccountAccess(req: Request, _res: Response, next: NextFunction) {
  if (!req.account) {
    throw new AuthorizationError("Account context required");
  }
  next();
}