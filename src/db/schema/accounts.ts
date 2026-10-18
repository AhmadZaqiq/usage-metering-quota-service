import { pgTable, bigserial, varchar, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accounts = pgTable(
  "accounts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    // Live names must be unique so concurrent bootstraps cannot duplicate
    // the bootstrap account. Soft-deleted names are reusable.
    nameUnique: uniqueIndex("uq_accounts_name").on(table.name).where(sql`${table.deletedAt} IS NULL`),
  })
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;