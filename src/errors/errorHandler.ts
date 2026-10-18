import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { pgErrorCode } from '../domain/pgError.js';
import { AppError } from './AppError.js';
import { logger } from '../logging/logger.js';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const requestId =
    (req.headers?.['x-request-id'] as string | undefined) ||
    (res.getHeader('X-Request-Id') as string | undefined) ||
    'unknown';

  if (err instanceof ZodError) {
    const details = err.flatten().fieldErrors;
    logger.warn({ err, requestId, details }, 'Validation error');
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details,
      },
    });
  }

  // body-parser (express.json) failures carry an HTTP status and a `type`:
  // malformed JSON is entity.parse.failed (400), payloads above the size
  // limit are entity.too.large (413). They are client errors and must never
  // surface as 500 INTERNAL_ERROR.
  if (err && typeof err === 'object' && 'type' in err && 'status' in err) {
    const parserType = (err as { type?: unknown }).type;
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      if (parserType === 'entity.parse.failed') {
        logger.warn({ requestId }, 'Malformed JSON payload');
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON payload' },
        });
      }
      if (parserType === 'entity.too.large') {
        logger.warn({ requestId }, 'Payload too large');
        return res.status(413).json({
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' },
        });
      }
      logger.warn({ requestId, status }, 'Rejected malformed request payload');
      return res.status(status).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload' },
      });
    }
  }

  if (err instanceof AppError) {
    const logLevel = err.statusCode >= 500 ? 'error' : 'warn';
    logger[logLevel]({ err, requestId, code: err.code, statusCode: err.statusCode }, err.message);
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  if (err && typeof err === 'object' && 'code' in err && pgErrorCode(err.code as string)) {
    const pgErr = err as { code: string; message: string; constraint?: string };
    logger.error(
      { err, requestId, pgCode: pgErr.code, constraint: pgErr.constraint },
      'Database error'
    );
    return handlePostgresError(pgErr, res, requestId);
  }

  logger.error({ err, requestId }, 'Unhandled error');
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
}

function handlePostgresError(
  err: { code: string; constraint?: string },
  res: Response,
  requestId: string
) {
  switch (err.code) {
    case '23505': {
      // unique_violation
      if (err.constraint?.includes('usage_requests')) {
        return res.status(409).json({
          error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key already used' },
        });
      }
      if (err.constraint?.includes('api_keys')) {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'API key prefix collision, please retry' },
        });
      }
      if (err.constraint?.includes('users')) {
        return res.status(409).json({
          error: { code: 'CONFLICT', message: 'User with this identifier already exists' },
        });
      }
      if (err.constraint?.includes('plan_assignments')) {
        return res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: 'Assignment conflict: overlapping period or duplicate current assignment',
          },
        });
      }
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'Resource already exists' },
      });
    }
    case '23503': // foreign_key_violation
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Referenced resource does not exist' },
      });
    case '23514': // check_violation
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Value violates constraint' },
      });
    case '22003': // numeric_value_out_of_range
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Numeric value out of range' },
      });
    case '22023': // invalid_text_representation
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid value format' },
      });
    case 'P0001': // raise_exception: application-defined rule failures are
      // business conflicts, not infrastructure faults (BR-20).
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'Operation conflicts with current state' },
      });
    case '40P01': // deadlock_detected
    case '40001': // serialization_failure
      return res.status(503).json({
        error: { code: 'TRANSACTION_CONFLICT', message: 'Transaction conflict, please retry' },
      });
    default:
      logger.error({ err, requestId }, 'Unhandled PostgreSQL error');
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Database error' },
      });
  }
}
