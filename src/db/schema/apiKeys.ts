import { pgTable, bigserial, bigint, varchar, char, boolean, timestamp, uniqueIndex, index, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts.js";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    accountId: bigint("account_id", { mode: "bigint" })
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    prefix: varchar("prefix", { length: 16 }).notNull(),
    keyHash: char("key_hash", { length: 64 }).notNull(),
    name: varchar("name", { length: 100 }),
    isRevoked: boolean("is_revoked").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    prefixUnique: uniqueIndex("uq_api_keys_prefix").on(table.prefix),
    accountIdx: index("idx_api_keys_account").on(table.accountId),
    activeIdx: index("idx_api_keys_active").on(table.prefix).where(sql`${table.isRevoked} = false`),
  })
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;