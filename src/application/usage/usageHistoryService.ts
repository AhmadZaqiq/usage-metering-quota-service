import { withTransaction } from "../../db/client.js";
import { getUsageHistory as getUsageHistoryFromRepository, type UsageHistoryResult } from "../../infrastructure/repositories/usageRequestRepository.js";
import { resolveUserId } from "./resolveUsageContext.js";

export async function getUsageHistory(
  accountId: bigint,
  page: number,
  limit: number,
  clientUserId?: string
): Promise<UsageHistoryResult> {
  return await withTransaction(async (tx) => {
    // Account-scoped resolution: the same clientUserId in another account is a
    // different user (uq_users_account_client_user), and an unknown name is a
    // 404 rather than a silently empty page.
    const userId = clientUserId !== undefined
      ? await resolveUserId(tx, accountId, clientUserId)
      : undefined;

    return getUsageHistoryFromRepository(tx, accountId, page, limit, userId ?? undefined);
  });
}
