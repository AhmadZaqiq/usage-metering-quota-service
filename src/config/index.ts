import { z } from "zod";

// Environment values are always strings when loaded from process.env.
// z.coerce.boolean() would parse the string "false" as true (Boolean("false")),
// so booleans are restricted to explicit "true"/"false" tokens; anything else
// fails validation instead of silently enabling a security-sensitive option.
const BooleanString = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => (typeof value === "boolean" ? value : value === "true"));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  MAX_UNITS_PER_REQUEST: z.coerce.number().int().positive().default(10_000),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  BOOTSTRAP_ACCOUNT_NAME: z.string().optional(),
  BOOTSTRAP_API_KEY_NAME: z.string().optional(),

  // Shared operator credential for POST /accounts (account provisioning).
  // Separate from tenant API keys; when unset the endpoint is disabled (404).
  // Compose interpolation emits "" when the variable is unset — treat empty
  // (or whitespace) exactly like unset instead of failing validation.
  OPERATOR_TOKEN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().min(16).optional()
  ),

  TRUST_PROXY: BooleanString.default(false),
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