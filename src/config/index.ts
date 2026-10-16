import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  MAX_UNITS_PER_REQUEST: z.coerce.number().int().positive().default(10_000),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  BOOTSTRAP_ACCOUNT_NAME: z.string().optional(),
  BOOTSTRAP_API_KEY_NAME: z.string().optional(),

  TRUST_PROXY: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const msg = Object.entries(errors)
      .map(([key, val]) => `${key}: ${val.join(", ")}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${msg}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export const MAX_UNITS_PER_REQUEST = getEnv().MAX_UNITS_PER_REQUEST;
export const MAX_UNITS_PER_REQUEST_BIGINT = BigInt(MAX_UNITS_PER_REQUEST);