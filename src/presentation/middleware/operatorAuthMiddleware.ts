import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { getEnv } from "../../config/index.js";
import { sha256Hex } from "../../domain/hash.js";
import { AuthenticationError, NotFoundError } from "../../errors/AppError.js";

export type OperatorAuthOutcome = "disabled" | "unauthorized" | "ok";

/**
 * Pure decision for the operator gate, extracted so the three states are
 * unit-testable without Express or the cached environment. Both sides are
 * hashed before the constant-time compare so comparison cost does not leak
 * token length.
 */
export function operatorAuthOutcome(
  configuredToken: string | undefined,
  authorizationHeader: string | undefined,
): OperatorAuthOutcome {
  if (!configuredToken) return "disabled";
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return "unauthorized";
  }
  const presented = authorizationHeader.slice(7);
  const actual = Buffer.from(sha256Hex(presented), "hex");
  const expected = Buffer.from(sha256Hex(configuredToken), "hex");
  return timingSafeEqual(actual, expected) ? "ok" : "unauthorized";
}

export function operatorAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
  const outcome = operatorAuthOutcome(getEnv().OPERATOR_TOKEN, req.headers.authorization);

  if (outcome === "disabled") {
    // The deployment does not offer HTTP account provisioning; behave like a
    // route that does not exist rather than advertising a disabled endpoint.
    throw new NotFoundError("Account provisioning is not enabled on this deployment");
  }
  if (outcome !== "ok") {
    throw new AuthenticationError("Valid operator token required");
  }

  next();
}
