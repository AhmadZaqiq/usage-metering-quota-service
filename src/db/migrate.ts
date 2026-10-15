import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, db } from "./client.js";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runCustomMigrations() {
  const sqlDir = join(__dirname, "sql");
  const files = readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = readFileSync(join(sqlDir, file), "utf-8");
    console.log(`Running custom migration: ${file}`);
    await pool.query(sql);
  }
}

async function main() {
  console.log("Running Drizzle migrations...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Drizzle migrations completed.");

  console.log("Running custom SQL migrations...");
  await runCustomMigrations();
  console.log("Custom migrations completed.");

  await pool.end();
  console.log("All migrations completed successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});