import { withTransaction } from "../../db/client.js";
import { getUsageHistory as getUsageHistoryFromRepository, type UsageHistoryResult } from "../../infrastructure/repositories/usageRequestRepository.js";

export async function getUsageHistory(
  accountId: bigint,
  page: number,
  limit: number
): Promise<UsageHistoryResult> {
  return await withTransaction(async (tx) => {
    return getUsageHistoryFromRepository(tx, accountId, page, limit);
  });
}
