import { NextFunction, Request, Response, RequestHandler } from "express";

/**
 * Wraps an async Express route handler/middleware so that rejected promises
 * are forwarded to next(err) and handled by the error-handling middleware,
 * instead of becoming unhandled rejections that crash the Node process.
 *
 * Express 4 does not catch rejections thrown by async handlers automatically,
 * so an uncaught error inside a route handler terminates the process and
 * closes the HTTP socket without sending a response.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
