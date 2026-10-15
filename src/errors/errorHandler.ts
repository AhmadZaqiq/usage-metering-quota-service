import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { pgErrorCode } from "../utils/pgError.js";
import { AppError, ValidationError, InternalError } from "./AppError.js";
import { logger } from "../logging/logger.js";

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const requestId = (res.getHeader("X-Request-Id") as string) || "unknown";

  if (err instanceof ZodError) {
    const details = err.flatten().fieldErrors;
    logger.warn({ err, requestId, details }, "Validation error");
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        details,
      },
    });
  }

  if (err instanceof AppError) {
    const logLevel = err.statusCode >= 500 ? "error" : "warn";
    logger[logLevel]({ err, requestId, code: err.code, statusCode: err.statusCode }, err.message);
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  if (err && typeof err === "object" && "code" in err && pgErrorCode(err.code as string)) {
    const pgErr = err as { code: string; message: string; constraint?: string };
    logger.error({ err, requestId, pgCode: pgErr.code, constraint: pgErr.constraint }, "Database error");
    return handlePostgresError(pgErr, res, requestId);
  }

  logger.error({ err, requestId }, "Unhandled error");
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });
}

function handlePostgresError(err: { code: string; constraint?: string }, res: Response, requestId: string) {
  switch (err.code) {
    case "23505": { // unique_violation
      if (err.constraint?.includes("usage_requests")) {
        return res.status(409).json({
          error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key already used" },
        });
      }
      if (err.constraint?.includes("api_keys")) {
        return res.status(409).json({
          error: { code: "CONFLICT", message: "API key prefix collision, please retry" },
        });
      }
      if (err.constraint?.includes("users")) {
        return res.status(409).json({
          error: { code: "CONFLICT", message: "User with this identifier already exists" },
        });
      }
      if (err.constraint?.includes("plan_assignments")) {
        return res.status(409).json({
          error: { code: "CONFLICT", message: "Assignment conflict: overlapping period or duplicate current assignment" },
        });
      }
      return res.status(409).json({
        error: { code: "CONFLICT", message: "Resource already exists" },
      });
    }
    case "23503": // foreign_key_violation
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Referenced resource does not exist" },
      });
    case "23514": // check_violation
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Value violates constraint" },
      });
    case "40P01": // deadlock_detected
    case "40001": // serialization_failure
      return res.status(503).json({
        error: { code: "TRANSACTION_CONFLICT", message: "Transaction conflict, please retry" },
      });
    default:
      logger.error({ err, requestId }, "Unhandled PostgreSQL error");
      return res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Database error" },
      });
  }
}