import { pgTable, bigserial, bigint, timestamp, index } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.js";
import { users } from "./users.js";
import { plans } from "./plans.js";

export const planAssignments = pgTable(
  "plan_assignments",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    accountId: bigint("account_id", { mode: "bigint" })
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    userId: bigint("user_id", { mode: "bigint" }).references(() => users.id, { onDelete: "restrict" }),
    planId: bigint("plan_id", { mode: "bigint" })
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountIdx: index("idx_plan_assignments_account").on(table.accountId),
    userIdx: index("idx_plan_assignments_user").on(table.userId),
  })
);

export type PlanAssignment = typeof planAssignments.$inferSelect;
export type NewPlanAssignment = typeof planAssignments.$inferInsert;