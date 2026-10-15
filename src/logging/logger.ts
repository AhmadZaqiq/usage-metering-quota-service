import pino from "pino";
import { getEnv } from "../config/index.js";

const env = getEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
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
});

export function createRequestLogger(base: pino.Logger, requestId: string, accountId?: number) {
  return base.child({
    requestId,
    accountId,
  });
}