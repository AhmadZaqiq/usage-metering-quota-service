import { checkDatabaseHealth } from "../../db/client.js";

export interface HealthStatus {
  status: "ok" | "degraded" | "not_ready";
  checks: {
    database: { healthy: boolean; latencyMs: number; error?: string };
  };
}

export async function getReadiness(): Promise<HealthStatus> {
  const dbHealth = await checkDatabaseHealth();

  const status = dbHealth.healthy ? "ok" : "not_ready";

  return {
    status,
    checks: {
      database: dbHealth,
    },
  };
}

export function getLiveness(): { status: "ok" } {
  return { status: "ok" };
}