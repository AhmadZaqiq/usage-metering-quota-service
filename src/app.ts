import express, { Request, Response, NextFunction } from "express";
import { authMiddleware } from "./presentation/middleware/authMiddleware.js";
import { errorHandler } from "./errors/errorHandler.js";
import { logger, createRequestLogger } from "./logging/logger.js";
import { createRateLimiterMiddleware, closeRateLimiterStore } from "./infrastructure/rateLimiter.js";
import { getEnv } from "./config/index.js";
import { asyncHandler } from "./presentation/middleware/asyncHandler.js";
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

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
    req.headers["x-request-id"] = requestId;
    req.logger = createRequestLogger(logger, requestId);
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

  const rateLimiter = createRateLimiterMiddleware();
  app.use(rateLimiter);

  app.use("/health", healthRoutes);

  app.use("/usage", asyncHandler(authMiddleware), usageRoutes);
  app.use("/api-keys", asyncHandler(authMiddleware), apiKeyRoutes);
  app.use("/plans", asyncHandler(authMiddleware), planRoutes);
  app.use("/assignments", asyncHandler(authMiddleware), assignmentRoutes);
  app.use("/users", asyncHandler(authMiddleware), userRoutes);

  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new Error("NOT_FOUND"));
  });

  app.use(errorHandler);

  return app;
}

export async function shutdown(): Promise<void> {
  await closeRateLimiterStore();
}