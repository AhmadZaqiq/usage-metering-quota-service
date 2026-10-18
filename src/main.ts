import { createApp, shutdown as appShutdown } from "./app.js";
import { getEnv } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { closePool } from "./db/client.js";

const env = getEnv();

// Fatal handlers must be registered before anything async can fail: an
// unhandled rejection would otherwise print a raw stack to stderr and leave
// the process running without observability.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "Server started");
});

// Explicit bounds so a stalled client cannot pin a connection indefinitely
// (Node defaults: 5 min request timeout, 60 s headers timeout).
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutdown initiated");
  // Stop serving keep-alive connections so server.close() can finish, then
  // drain in-flight requests.
  server.closeIdleConnections();
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