export interface PlanQuota {
  monthlyAllowance: bigint;
  maxUnitsPerRequest: bigint;
}

export interface QuotaInput {
  accountPlan: PlanQuota;
  userPlan: PlanQuota | null;
  accountUsed: bigint;
  userUsed: bigint;
  requestedUnits: bigint;
  maxUnitsPerRequestLimit: bigint;
}

export type RejectionReason =
  | "account_quota_exceeded"
  | "user_quota_exceeded"
  | "max_per_request_exceeded";

export interface QuotaResult {
  decision: "accepted" | "rejected";
  rejectionReason?: RejectionReason;
  accountRemaining: bigint;
  userRemaining?: bigint;
}

export function evaluateQuota(input: QuotaInput): QuotaResult {
  const { accountPlan, userPlan, accountUsed, userUsed, requestedUnits, maxUnitsPerRequestLimit } = input;

  if (requestedUnits <= 0n) {
    return {
      decision: "rejected",
      rejectionReason: "max_per_request_exceeded",
      accountRemaining: accountPlan.monthlyAllowance - accountUsed,
      userRemaining: userPlan ? userPlan.monthlyAllowance - userUsed : undefined,
    };
  }

  if (requestedUnits > maxUnitsPerRequestLimit) {
    return {
      decision: "rejected",
      rejectionReason: "max_per_request_exceeded",
      accountRemaining: accountPlan.monthlyAllowance - accountUsed,
      userRemaining: userPlan ? userPlan.monthlyAllowance - userUsed : undefined,
    };
  }

  const accountRemaining = accountPlan.monthlyAllowance - accountUsed;
  const userRemaining = userPlan ? userPlan.monthlyAllowance - userUsed : undefined;

  const maxPerRequest = userPlan
    ? accountPlan.maxUnitsPerRequest < userPlan.maxUnitsPerRequest
      ? accountPlan.maxUnitsPerRequest
      : userPlan.maxUnitsPerRequest
    : accountPlan.maxUnitsPerRequest;

  if (requestedUnits > maxPerRequest) {
    return {
      decision: "rejected",
      rejectionReason: "max_per_request_exceeded",
      accountRemaining,
      userRemaining,
    };
  }

  if (requestedUnits > accountRemaining) {
    return {
      decision: "rejected",
      rejectionReason: "account_quota_exceeded",
      accountRemaining,
      userRemaining,
    };
  }

  if (userPlan && requestedUnits > (userRemaining ?? 0n)) {
    return {
      decision: "rejected",
      rejectionReason: "user_quota_exceeded",
      accountRemaining,
      userRemaining,
    };
  }

  return {
    decision: "accepted",
    accountRemaining: accountRemaining - requestedUnits,
    userRemaining: userPlan ? (userRemaining! - requestedUnits) : undefined,
  };
}