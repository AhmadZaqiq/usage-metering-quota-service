import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { getEnv } from "../config/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Module-relative so `node dist/db/migrate.js` works from any working
// directory: resolves to <repo-or-image-root>/src/db/migrations both from
// src/db (tsx) and dist/db (compiled).
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "src", "db", "migrations");

// Fixed application namespace for the migration advisory lock. All migrators
// (multiple replicas, docker-compose up) must serialize on the same key so two
// processes can never interleave journal writes or custom SQL files.
const MIGRATION_LOCK_KEY = 867_530_9;

async function runCustomMigrations(client: Client): Promise<void> {
  const sqlDir = join(__dirname, "sql");
  const files = readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = readFileSync(join(sqlDir, file), "utf-8");
    console.log(`Running custom migration: ${file}`);
    await client.query(sql);
  }
}

async function main() {
  const env = getEnv();

  // One dedicated session for the whole migration run: advisory locks are
  // session-scoped, so the lock, the journal migration, and the custom SQL
  // must all execute on the same connection.
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    console.log("Acquired migration advisory lock");

    const db = drizzle(client);

    console.log("Running Drizzle migrations...");
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("Drizzle migrations completed.");

    console.log("Running custom SQL migrations...");
    await runCustomMigrations(client);
    console.log("Custom migrations completed.");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }

  console.log("All migrations completed successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
