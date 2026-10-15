import { pgTable, bigserial, varchar, boolean, timestamp, index } from "drizzle-orm/pg-core";
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
    activeIdx: index("idx_accounts_active").on(table.id).where(sql`${table.isActive} = true AND ${table.deletedAt} IS NULL`),
  })
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;