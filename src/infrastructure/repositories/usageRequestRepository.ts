import { sql } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";

export interface UsageRequestRow {
  id: bigint;
  accountId: bigint;
  userId: bigint | null;
  idempotencyKey: string;
  requestHash: string;
  units: bigint;
  decision: string;
  rejectionReason: string | null;
  periodStart: string;
  accountRemaining: bigint | null;
  userRemaining: bigint | null;
  createdAt: Date;
}

function mapRowToUsageRequest(row: Record<string, unknown>): UsageRequestRow {
  return {
    id: row.id as bigint,
    accountId: row.accountId as bigint,
    userId: (row.userId as bigint | null) ?? null,
    idempotencyKey: row.idempotencyKey as string,
    requestHash: row.requestHash as string,
    units: row.units as bigint,
    decision: row.decision as string,
    rejectionReason: row.rejectionReason as string | null,
    periodStart: row.periodStart as string,
    accountRemaining: (row.accountRemaining as bigint | null) ?? null,
    userRemaining: (row.userRemaining as bigint | null) ?? null,
    createdAt: row.createdAt as Date,
  };
}

export async function findUsageRequestByKey(
  tx: Transaction,
  accountId: bigint,
  idempotencyKey: string
): Promise<UsageRequestRow[]> {
  const result = await tx.execute(sql`
    SELECT id, account_id as "accountId", user_id as "userId", idempotency_key as "idempotencyKey", 
           request_hash as "requestHash", units, decision, rejection_reason as "rejectionReason", 
           period_start as "periodStart", account_remaining as "accountRemaining", 
           user_remaining as "userRemaining", created_at as "createdAt"
    FROM usage_requests
    WHERE account_id = ${accountId} AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  return result.rows.map(mapRowToUsageRequest);
}

export async function insertUsageRequest(
  tx: Transaction,
  accountId: bigint,
  userId: bigint | null,
  idempotencyKey: string,
  requestHash: string,
  units: bigint,
  decision: string,
  rejectionReason: string | null,
  periodStart: string,
  accountRemaining: bigint | null,
  userRemaining: bigint | null,
): Promise<UsageRequestRow[]> {
  const result = await tx.execute(sql`
    INSERT INTO usage_requests (account_id, user_id, idempotency_key, request_hash, units, decision, rejection_reason, period_start, account_remaining, user_remaining)
    VALUES (${accountId}, ${userId}, ${idempotencyKey}, ${requestHash}, ${units}, ${decision}, ${rejectionReason}, ${periodStart}, ${accountRemaining}, ${userRemaining})
    ON CONFLICT (account_id, idempotency_key) DO NOTHING
    RETURNING id, account_id as "accountId", user_id as "userId", idempotency_key as "idempotencyKey", request_hash as "requestHash", units, decision, rejection_reason as "rejectionReason", period_start as "periodStart", account_remaining as "accountRemaining", user_remaining as "userRemaining", created_at as "createdAt"
  `);
  return result.rows.map(mapRowToUsageRequest);
}

export interface UsageHistoryItem {
  id: string;
  userId: string | null;
  units: string;
  decision: string;
  rejectionReason: string | null;
  periodStart: string;
  accountRemaining: string | null;
  userRemaining: string | null;
  createdAt: string;
}

export interface UsageHistoryResult {
  items: UsageHistoryItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export async function getUsageHistory(
  tx: Transaction,
  accountId: bigint,
  page: number,
  limit: number
): Promise<UsageHistoryResult> {
  const offset = (page - 1) * limit;

  const [rows, countResult] = await Promise.all([
    tx.execute(sql`
      SELECT id, user_id as "userId", idempotency_key as "idempotencyKey", units, decision, rejection_reason as "rejectionReason",
             period_start as "periodStart", account_remaining as "accountRemaining",
             user_remaining as "userRemaining", created_at as "createdAt"
      FROM usage_requests
      WHERE account_id = ${accountId}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    tx.execute(sql`
      SELECT count(*) as "count" FROM usage_requests WHERE account_id = ${accountId}
    `),
  ]);

  const items: UsageHistoryItem[] = (rows.rows as Array<{
    id: bigint;
    userId: bigint | null;
    idempotencyKey: string;
    units: bigint;
    decision: string;
    rejectionReason: string | null;
    periodStart: string;
    accountRemaining: bigint | null;
    userRemaining: bigint | null;
    createdAt: string | Date;
  }>).map((row) => ({
    id: row.id.toString(),
    userId: row.userId ? row.userId.toString() : null,
    idempotencyKey: row.idempotencyKey,
    units: row.units.toString(),
    decision: row.decision,
    rejectionReason: row.rejectionReason,
    periodStart: row.periodStart,
    // Explicit null checks: bigint 0n is falsy but is a real value (quota
    // fully consumed), not a missing one.
    accountRemaining: row.accountRemaining !== null ? row.accountRemaining.toString() : null,
    userRemaining: row.userRemaining !== null ? row.userRemaining.toString() : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }));

  const total = Number((countResult.rows as Array<{ count: string }>)[0].count);
  const totalPages = Math.ceil(total / limit);

  return { items, total, page, limit, totalPages };
}
