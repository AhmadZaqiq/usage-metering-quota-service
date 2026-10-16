import { createApp, shutdown as appShutdown } from "./app.js";
import { getEnv } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { closePool } from "./db/client.js";

const env = getEnv();

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "Server started");
});

function shutdown(signal: string) {
  logger.info({ signal }, "Shutdown initiated");
  server.close(async () => {
    logger.info("HTTP server closed");
    try {
      await Promise.all([closePool(), appShutdown()]);
      logger.info("Database pool and rate limiter closed");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  });

  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));