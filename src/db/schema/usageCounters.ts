import { pgTable, bigserial, bigint, timestamp, date, uniqueIndex, index, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts.js";
import { users } from "./users.js";

export const usageCounters = pgTable(
  "usage_counters",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    accountId: bigint("account_id", { mode: "bigint" })
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .default(sql`0`)
      .references(() => users.id, { onDelete: "restrict" }),
    periodStart: date("period_start").notNull(),
    counter: bigint("counter", { mode: "bigint" }).notNull().default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    counterNonNegative: check("chk_counter_non_negative", sql`${table.counter} >= 0`),
    accountUserPeriodUnique: uniqueIndex("uq_usage_counters_account_user_period").on(table.accountId, table.userId, table.periodStart),
    lookupIdx: index("idx_usage_counters_lookup").on(table.accountId, table.userId, table.periodStart),
  })
);

export type UsageCounter = typeof usageCounters.$inferSelect;
export type NewUsageCounter = typeof usageCounters.$inferInsert;