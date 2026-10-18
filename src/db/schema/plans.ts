import { pgTable, bigserial, varchar, boolean, timestamp, bigint, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts.js";

export const plans = pgTable(
  "plans",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    ownerAccountId: bigint("owner_account_id", { mode: "bigint" }).references(() => accounts.id, { onDelete: "restrict" }),
    monthlyAllowance: bigint("monthly_allowance", { mode: "bigint" }).notNull(),
    maxUnitsPerRequest: bigint("max_units_per_request", { mode: "bigint" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    typeCheck: check("chk_plan_type", sql`${table.type} IN ('account', 'user')`),
    allowancePositive: check("chk_plan_allowance_positive", sql`${table.monthlyAllowance} > 0`),
    maxUnitsPositive: check("chk_plan_max_units_positive", sql`${table.maxUnitsPerRequest} > 0`),
    // NOTE: uq_system_plans / uq_custom_plans (soft-delete-aware name uniques)
    // and assignment overlap constraints are managed by custom SQL in
    // src/db/sql/ — see README "Database migrations". Keep that channel
    // authoritative; the generated Drizzle snapshot does not track them.
  })
);

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;