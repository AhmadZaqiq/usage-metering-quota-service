import { checkDatabaseHealth } from "../../db/client.js";
import { logger } from "../../logging/logger.js";

export interface HealthStatus {
  status: "ok" | "degraded" | "not_ready";
  checks: {
    // The raw driver error may contain hostnames, usernames, or connection
    // details, so it is logged server-side only; the HTTP response carries a
    // stable generic message instead.
    database: { healthy: boolean; latencyMs: number; error?: string };
  };
}

export async function getReadiness(): Promise<HealthStatus> {
  const dbHealth = await checkDatabaseHealth();

  if (!dbHealth.healthy) {
    logger.warn({ error: dbHealth.error }, "Database health check failed");
    return {
      status: "not_ready",
      checks: {
        database: { healthy: false, latencyMs: dbHealth.latencyMs, error: "database unavailable" },
      },
    };
  }

  return {
    status: "ok",
    checks: {
      database: { healthy: true, latencyMs: dbHealth.latencyMs },
    },
  };
}

export function getLiveness(): { status: "ok" } {
  return { status: "ok" };
}
