import { withTransaction } from "../../db/client.js";
import {
  selectCountersByAccountPeriod,
} from "../../infrastructure/repositories/counterRepository.js";
import {
  selectCurrentPlanSummaries,
} from "../../infrastructure/repositories/assignmentRepository.js";
import { selectUsersByAccount } from "../../infrastructure/repositories/userRepository.js";
import { resolveUserId } from "./resolveUsageContext.js";
import { getUtcMonthStart, formatDateForDb } from "../../domain/date.js";
import { ValidationError } from "../../errors/AppError.js";

export interface UsageSummaryPlanBlock {
  planId: string | null;
  planName: string | null;
  monthlyAllowance: string | null;
  maxUnitsPerRequest: string | null;
  consumed: string;
  remaining: string | null;
}

export interface UserSummaryBlock extends UsageSummaryPlanBlock {
  userId: string;
  clientUserId: string;
  isActive: boolean;
}

export interface UsageSummaryResult {
  periodStart: string;
  account: UsageSummaryPlanBlock & { accountId: string };
  users: UserSummaryBlock[];
}

/**
 * Parse the optional `periodStart` query value. Accepts `YYYY-MM` (preferred)
 * or the stored date form `YYYY-MM-01`; rejects malformed input and future
 * periods (a future month has no authoritative counter yet).
 */
export function parsePeriodStart(
  raw: string | undefined,
  now: Date = new Date(),
): string {
  if (raw === undefined) {
    return formatDateForDb(getUtcMonthStart(now));
  }

  const match = /^(\d{4})-(\d{2})(?:-01)?$/.exec(raw);
  if (!match) {
    throw new ValidationError("Invalid periodStart", {
      periodStart: ["Must be YYYY-MM or YYYY-MM-01"],
    });
  }
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new ValidationError("Invalid periodStart", {
      periodStart: ["Month must be between 01 and 12"],
    });
  }

  const requested = `${match[1]}-${match[2]}-01`;
  const current = formatDateForDb(getUtcMonthStart(now));
  if (requested > current) {
    throw new ValidationError("Invalid periodStart", {
      periodStart: ["Future periods cannot be summarized; counters do not exist yet"],
    });
  }
  return requested;
}

function clampNonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

/**
 * Aggregated consumed/remaining view for one UTC month, straight from the
 * authoritative counters (never by summing the request log). `consumed` is
 * exact for every period; `monthlyAllowance`/`remaining` always reflect the
 * *currently* effective plan (plan changes do not rewrite history, and a
 * lowered allowance clamps remaining at zero exactly like POST /usage).
 *
 * Absent plan or counter rows are represented explicitly (nulls / "0") so a
 * read never fails the way a metered write would (POST /usage still 409s on
 * a missing plan).
 */
export async function getUsageSummary(
  accountId: number,
  periodStart: string,
  clientUserId?: string,
): Promise<UsageSummaryResult> {
  return await withTransaction(async (tx) => {
    const userId = clientUserId !== undefined
      ? await resolveUserId(tx, BigInt(accountId), clientUserId)
      : undefined;

    const [planSummaries, counters, users] = await Promise.all([
      selectCurrentPlanSummaries(tx, BigInt(accountId)),
      selectCountersByAccountPeriod(tx, BigInt(accountId), periodStart),
      selectUsersByAccount(tx, BigInt(accountId)),
    ]);

    const accountPlan = planSummaries.find((p) => p.userId === null) ?? null;
    const userPlans = new Map(
      planSummaries.filter((p) => p.userId !== null).map((p) => [p.userId!.toString(), p]),
    );
    const counterByUser = new Map(
      counters.map((c) => [c.userId === null ? null : c.userId.toString(), c.counter]),
    );

    const accountConsumed = counterByUser.get(null) ?? 0n;
    const accountBlock = {
      accountId: String(accountId),
      planId: accountPlan ? accountPlan.planId.toString() : null,
      planName: accountPlan ? accountPlan.planName : null,
      monthlyAllowance: accountPlan ? accountPlan.monthlyAllowance.toString() : null,
      maxUnitsPerRequest: accountPlan ? accountPlan.maxUnitsPerRequest.toString() : null,
      consumed: accountConsumed.toString(),
      remaining: accountPlan
        ? clampNonNegative(accountPlan.monthlyAllowance - accountConsumed).toString()
        : null,
    };

    const userBlocks: UserSummaryBlock[] = users
      .filter((u) => userId === undefined || u.id === userId)
      .map((u) => {
        const plan = userPlans.get(u.id.toString()) ?? null;
        const consumed = counterByUser.get(u.id.toString()) ?? 0n;
        return {
          userId: u.id.toString(),
          clientUserId: u.clientUserId,
          isActive: u.isActive,
          planId: plan ? plan.planId.toString() : null,
          planName: plan ? plan.planName : null,
          monthlyAllowance: plan ? plan.monthlyAllowance.toString() : null,
          maxUnitsPerRequest: plan ? plan.maxUnitsPerRequest.toString() : null,
          consumed: consumed.toString(),
          remaining: plan
            ? clampNonNegative(plan.monthlyAllowance - consumed).toString()
            : null,
        };
      });

    return {
      periodStart,
      account: accountBlock,
      users: userBlocks,
    };
  });
}
