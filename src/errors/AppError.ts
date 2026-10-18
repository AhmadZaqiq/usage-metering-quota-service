export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication failed") {
    super(401, "AUTHENTICATION_FAILED", message);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Access denied") {
    super(403, "AUTHORIZATION_FAILED", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, "CONFLICT", message, details);
  }
}

export class InternalError extends AppError {
  constructor(message = "Internal server error", details?: Record<string, unknown>) {
    super(500, "INTERNAL_ERROR", message, details);
  }
}