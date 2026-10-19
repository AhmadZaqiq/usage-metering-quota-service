import { sql, and, desc, eq } from "drizzle-orm";
import type { Transaction } from "../../db/client.js";
import { usageRequests } from "../../db/schema/index.js";

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
  const result = await tx
    .select()
    .from(usageRequests)
    .where(
      and(
        eq(usageRequests.accountId, accountId),
        eq(usageRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1)
    .execute();
  return result.map(mapRowToUsageRequest);
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
  createdAt: string,
): Promise<UsageRequestRow[]> {
  const result = await tx.execute(sql`
    INSERT INTO usage_requests (account_id, user_id, idempotency_key, request_hash, units, decision, rejection_reason, period_start, account_remaining, user_remaining, created_at)
    VALUES (${accountId}, ${userId}, ${idempotencyKey}, ${requestHash}, ${units}, ${decision}, ${rejectionReason}, ${periodStart}, ${accountRemaining}, ${userRemaining}, ${createdAt})
    ON CONFLICT (account_id, idempotency_key) DO NOTHING
    RETURNING id, account_id as "accountId", user_id as "userId", idempotency_key as "idempotencyKey", request_hash as "requestHash", units, decision, rejection_reason as "rejectionReason", period_start as "periodStart", account_remaining as "accountRemaining", user_remaining as "userRemaining", created_at as "createdAt"
  `);
  return result.rows.map(mapRowToUsageRequest);
}

export interface UsageHistoryItem {
  id: string;
  requestId: string;
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
  limit: number,
  userIdFilter?: bigint
): Promise<UsageHistoryResult> {
  const offset = (page - 1) * limit;
  // undefined = no subject filter (includes account-scoped rows); a bigint
  // restricts to that user's rows and therefore excludes NULL user_id rows.
  const scoped = userIdFilter === undefined
    ? eq(usageRequests.accountId, accountId)
    : and(eq(usageRequests.accountId, accountId), eq(usageRequests.userId, userIdFilter))!;

  const [rows, countResult] = await Promise.all([
    tx
      .select({
        id: usageRequests.id,
        userId: usageRequests.userId,
        idempotencyKey: usageRequests.idempotencyKey,
        units: usageRequests.units,
        decision: usageRequests.decision,
        rejectionReason: usageRequests.rejectionReason,
        periodStart: usageRequests.periodStart,
        accountRemaining: usageRequests.accountRemaining,
        userRemaining: usageRequests.userRemaining,
        createdAt: usageRequests.createdAt,
      })
      .from(usageRequests)
      .where(scoped)
      .orderBy(desc(usageRequests.createdAt))
      .limit(limit)
      .offset(offset)
      .execute(),
    tx
      .select({ count: sql`count(*)` })
      .from(usageRequests)
      .where(scoped)
      .execute(),
  ]);

  const items: UsageHistoryItem[] = rows.map((row) => ({
    id: row.id.toString(),
    // Public contract field name; storage column stays usage_requests.idempotency_key.
    requestId: row.idempotencyKey,
    userId: row.userId ? row.userId.toString() : null,
    units: row.units.toString(),
    decision: row.decision,
    rejectionReason: row.rejectionReason,
    periodStart: row.periodStart,
    // Explicit null checks: bigint 0n is falsy but is a real value (quota
    // fully consumed), not a missing one.
    accountRemaining: row.accountRemaining !== null ? row.accountRemaining.toString() : null,
    userRemaining: row.userRemaining !== null ? row.userRemaining.toString() : null,
    createdAt: row.createdAt.toISOString(),
  }));

  const total = Number((countResult[0] as { count: string | number }).count);
  const totalPages = Math.ceil(total / limit);

  return { items, total, page, limit, totalPages };
}
