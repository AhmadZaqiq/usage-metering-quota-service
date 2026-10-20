import { beforeAll, afterAll, afterEach, vi } from "vitest";
import { Pool } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as schema from "../db/schema/index.js";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://app:app_secret@localhost:5433/usage_metering_test";

// Point the application's database client at the dedicated test database
// before any test file imports service modules. Service modules create their
// pooled pg client at import time from DATABASE_URL (src/db/client.ts), and
// getEnv() caches the result (src/config/index.ts), so DATABASE_URL must be
// set here - setup files are evaluated before test files - rather than only
// in beforeAll, which would run too late.
setTestEnv();

let testPool: Pool;
let testDb: NodePgDatabase<typeof schema>;

export function setTestEnv() {
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  // Operator credential for POST /accounts tests (getEnv() caches on first
  // access, so it must be set here with the other bootstrap env vars).
  process.env.OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "test-operator-token-audit";
}

export function getTestDb(): NodePgDatabase<typeof schema> {
  if (!testDb) {
    throw new Error("Test database not initialized. Call setupTestDatabase() first.");
  }
  return testDb;
}

export function getTestPool(): Pool {
  if (!testPool) {
    throw new Error("Test pool not initialized. Call setupTestDatabase() first.");
  }
  return testPool;
}

async function runCustomMigrations(pool: Pool) {
  const sqlDir = join(__dirname, "../db/sql");
  const files = readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = readFileSync(join(sqlDir, file), "utf-8");
    await pool.query(sql);
  }
}

export async function setupTestDatabase(): Promise<void> {
  testPool = new Pool({
    connectionString: TEST_DB_URL,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

  const db = drizzle(testPool, { schema, logger: false });

  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  await runCustomMigrations(testPool);

  testDb = db;
}

export async function teardownTestDatabase(): Promise<void> {
  if (testPool) {
    await testPool.end();
    testPool = undefined as any;
    testDb = undefined as any;
  }
}

export async function truncateTestTables(): Promise<void> {
  if (!testPool) return;

  const tables = [
    "usage_requests",
    "usage_counters",
    "plan_assignments",
    "users",
    "api_keys",
    "plans",
    "accounts",
  ];

  for (const table of tables) {
    try {
      await testPool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
    } catch (err) {
      // Table might not exist or other issue, continue
      console.warn(`Failed to truncate ${table}:`, (err as Error).message);
    }
  }
}

beforeAll(async () => {
  setTestEnv();
  await setupTestDatabase();
}, 120_000);

afterAll(async () => {
  await teardownTestDatabase();
}, 30_000);

afterEach(async () => {
  await truncateTestTables();
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
