import { pgTable, bigserial, bigint, varchar, char, timestamp, date, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts.js";
import { users } from "./users.js";

export const usageRequests = pgTable(
  "usage_requests",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    accountId: bigint("account_id", { mode: "bigint" })
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    userId: bigint("user_id", { mode: "bigint" }).references(() => users.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    units: bigint("units", { mode: "bigint" }).notNull(),
    decision: varchar("decision", { length: 20 }).notNull(),
    rejectionReason: varchar("rejection_reason", { length: 100 }),
    periodStart: date("period_start").notNull(),
    accountRemaining: bigint("account_remaining", { mode: "bigint" }),
    userRemaining: bigint("user_remaining", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unitsPositive: check("chk_usage_request_units_positive", sql`${table.units} > 0`),
    decisionCheck: check("chk_usage_request_decision", sql`${table.decision} IN ('accepted', 'rejected')`),
    idempotencyUnique: uniqueIndex("uq_usage_requests_account_idempotency").on(table.accountId, table.idempotencyKey),
    accountTimeIdx: index("idx_usage_requests_account_time").on(table.accountId, table.createdAt),
    userTimeIdx: index("idx_usage_requests_user_time").on(table.userId, table.createdAt),
  })
);

export type UsageRequest = typeof usageRequests.$inferSelect;
export type NewUsageRequest = typeof usageRequests.$inferInsert;