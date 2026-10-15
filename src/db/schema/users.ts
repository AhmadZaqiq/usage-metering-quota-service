import { pgTable, bigserial, varchar, boolean, timestamp, bigint, uniqueIndex, index, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts } from "./accounts.js";

export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    accountId: bigint("account_id", { mode: "bigint" })
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    clientUserId: varchar("client_user_id", { length: 255 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    accountClientUserUnique: uniqueIndex("uq_users_account_client_user").on(table.accountId, table.clientUserId),
    accountIdIdUnique: uniqueIndex("uq_users_account_id_id").on(table.accountId, table.id),
    accountIdx: index("idx_users_account").on(table.accountId).where(sql`${table.deletedAt} IS NULL`),
  })
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;