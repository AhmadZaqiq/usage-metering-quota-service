import express from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "./modules/auth/authMiddleware.js";
import { errorHandler } from "./errors/errorHandler.js";
import { logger, createRequestLogger } from "./logging/logger.js";
import { getEnv } from "./config/index.js";
import usageRoutes from "./routes/usageRoutes.js";
import apiKeyRoutes from "./routes/apiKeyRoutes.js";
import planRoutes from "./routes/planRoutes.js";
import assignmentRoutes from "./routes/assignmentRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import healthRoutes from "./routes/healthRoutes.js";

const env = getEnv();

export function createApp(): express.Application {
  const app = express();

  app.use(express.json({ limit: "64kb" }));

  app.use((req, _res, next) => {
    const requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
    req.headers["x-request-id"] = requestId;
    const requestLogger = createRequestLogger(logger, requestId);
    (req as any).logger = requestLogger;
    next();
  });

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const requestLogger = (req as any).logger;
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

  const limiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const key = authHeader.slice(7);
        const prefix = key.split(".")[0];
        return `key:${prefix}`;
      }
      return `ip:${req.ip}`;
    },
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: "RATE_LIMITED", message: "Too many requests" },
      });
    },
  });

  app.use(limiter);

  app.use("/health", healthRoutes);

  app.use("/usage", authMiddleware, usageRoutes);
  app.use("/api-keys", authMiddleware, apiKeyRoutes);
  app.use("/plans", authMiddleware, planRoutes);
  app.use("/assignments", authMiddleware, assignmentRoutes);
  app.use("/users", authMiddleware, userRoutes);

  app.use((_req, _res, next) => {
    next(new Error("NOT_FOUND"));
  });

  app.use(errorHandler);

  return app;
}