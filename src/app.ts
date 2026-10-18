import express, { Request, Response, NextFunction } from "express";
import { authMiddleware } from "./presentation/middleware/authMiddleware.js";
import { errorHandler } from "./errors/errorHandler.js";
import { logger, createRequestLogger } from "./logging/logger.js";
import {
  createIpRateLimiterMiddleware,
  createIdentityRateLimiterMiddleware,
  closeRateLimiterStore,
} from "./infrastructure/rateLimiter.js";
import { getEnv } from "./config/index.js";
import { asyncHandler } from "./presentation/middleware/asyncHandler.js";
import { NotFoundError } from "./errors/AppError.js";
import usageRoutes from "./presentation/routes/usageRoutes.js";
import apiKeyRoutes from "./presentation/routes/apiKeyRoutes.js";
import planRoutes from "./presentation/routes/planRoutes.js";
import assignmentRoutes from "./presentation/routes/assignmentRoutes.js";
import userRoutes from "./presentation/routes/userRoutes.js";
import healthRoutes from "./presentation/routes/healthRoutes.js";

declare module "express" {
  interface Request {
    logger?: ReturnType<typeof createRequestLogger>;
  }
}

export function createApp(): express.Application {
  const app = express();
  const env = getEnv();

  if (env.TRUST_PROXY) {
    app.enable("trust proxy");
  }

  app.use(express.json({ limit: "64kb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
    req.headers["x-request-id"] = requestId;
    req.logger = createRequestLogger(logger, requestId);
    // Mirror the correlation id so clients and error logs share it.
    res.setHeader("X-Request-Id", requestId);
    // Minimal security headers for a JSON API.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const requestLogger = req.logger;
      if (requestLogger) {
        requestLogger.info(
          {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: Date.now() - start,
          },
          "HTTP request"
        );
      }
    });
    next();
  });

  // Layer 1: IP-keyed limit before authentication (never trusts credentials).
  app.use(createIpRateLimiterMiddleware());

  app.use("/health", healthRoutes);

  // Layer 2: identity-keyed limit after successful verification (tenant isolation).
  const authenticated = [asyncHandler(authMiddleware), createIdentityRateLimiterMiddleware()];

  app.use("/usage", ...authenticated, usageRoutes);
  app.use("/api-keys", ...authenticated, apiKeyRoutes);
  app.use("/plans", ...authenticated, planRoutes);
  app.use("/assignments", ...authenticated, assignmentRoutes);
  app.use("/users", ...authenticated, userRoutes);

  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new NotFoundError());
  });

  app.use(errorHandler);

  return app;
}

export async function shutdown(): Promise<void> {
  await closeRateLimiterStore();
}