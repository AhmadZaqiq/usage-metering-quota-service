import pino from "pino";
import { getEnv } from "../config/index.js";

const env = getEnv();

// Defense in depth: request logging never emits headers today, but any future
// log line that spreads a request/response object must not leak credentials.
// Exported so tests can assert the redaction behavior of these exact paths.
export const REDACT_PATHS = [
  "authorization",
  "req.headers.authorization",
  "res.headers.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "req.headers['x-api-key']",
  "headers['x-api-key']",
  "cookie",
  "req.headers.cookie",
  "headers.cookie",
];

// Exported so tests exercise the exact same options the app logger uses.
export function buildLoggerOptions(): pino.LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    transport: env.NODE_ENV === "development" ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    } : undefined,
    base: {
      service: "usage-metering-quota-service",
      env: env.NODE_ENV,
    },
  };
}

export const logger = pino(buildLoggerOptions());

export function createRequestLogger(base: pino.Logger, requestId: string, accountId?: number) {
  return base.child({
    requestId,
    accountId,
  });
}