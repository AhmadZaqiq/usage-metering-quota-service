import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, PoolConfig } from "pg";
import * as schema from "./schema/index.js";
import { getEnv } from "../config/index.js";

const env = getEnv();

const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export const pool = new Pool(poolConfig);

pool.on("error", (err) => {
  console.error("Unexpected pool error", err);
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema, logger: false });

export async function closePool(): Promise<void> {
  await pool.end();
}

export type Transaction = NodePgDatabase<typeof schema>;

export interface TransactionOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 50;

const RETRYABLE_CODES = new Set(["40P01", "40001"]);

export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await db.transaction(fn);
    } catch (err) {
      lastError = err as Error;
      const pgCode = (err as { code?: string }).code;

      if (pgCode && RETRYABLE_CODES.has(pgCode) && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }

  throw lastError!;
}

export async function checkDatabaseHealth(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { healthy: false, latencyMs: Date.now() - start, error: (err as Error).message };
  }
}