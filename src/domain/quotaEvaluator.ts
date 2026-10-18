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
  'account_quota_exceeded' | 'user_quota_exceeded' | 'max_per_request_exceeded';

/**
 * Which layer's per-request cap the request breached. Only set for
 * `max_per_request_exceeded` so callers can tell "your plan's per-request cap"
 * apart from "the global per-request limit" without parsing numbers.
 */
export type LimitScope = 'global' | 'account' | 'user';

export interface QuotaResult {
  decision: 'accepted' | 'rejected';
  rejectionReason?: RejectionReason;
  /** Set only when rejectionReason is `max_per_request_exceeded`. */
  limitScope?: LimitScope;
  accountRemaining: bigint;
  userRemaining?: bigint;
}

export function evaluateQuota(input: QuotaInput): QuotaResult {
  const { accountPlan, userPlan, accountUsed, userUsed, requestedUnits, maxUnitsPerRequestLimit } =
    input;

  // A plan allowance reduced below already-consumed usage must expose zero
  // remaining (never a negative balance), while still rejecting further
  // consumption at that level.
  const accountRemaining = clampNonNegative(accountPlan.monthlyAllowance - accountUsed);
  const userRemaining = userPlan
    ? clampNonNegative(userPlan.monthlyAllowance - userUsed)
    : undefined;

  if (requestedUnits <= 0n) {
    return {
      decision: 'rejected',
      rejectionReason: 'max_per_request_exceeded',
      // Not reachable via the HTTP API (Zod rejects units <= 0 with 400 first);
      // attributed to the global limit because it is an invariant, not a plan cap.
      limitScope: 'global',
      accountRemaining,
      userRemaining,
    };
  }

  if (requestedUnits > maxUnitsPerRequestLimit) {
    return {
      decision: 'rejected',
      rejectionReason: 'max_per_request_exceeded',
      limitScope: 'global',
      accountRemaining,
      userRemaining,
    };
  }

  const maxPerRequest = userPlan
    ? accountPlan.maxUnitsPerRequest < userPlan.maxUnitsPerRequest
      ? accountPlan.maxUnitsPerRequest
      : userPlan.maxUnitsPerRequest
    : accountPlan.maxUnitsPerRequest;

  if (requestedUnits > maxPerRequest) {
    // Scope the breach to the tighter plan cap, so callers know whether the
    // account-level or user-level per-request limit rejected the request.
    const scope: LimitScope =
      userPlan && userPlan.maxUnitsPerRequest < accountPlan.maxUnitsPerRequest
        ? 'user'
        : 'account';
    return {
      decision: 'rejected',
      rejectionReason: 'max_per_request_exceeded',
      limitScope: scope,
      accountRemaining,
      userRemaining,
    };
  }

  if (requestedUnits > accountRemaining) {
    return {
      decision: 'rejected',
      rejectionReason: 'account_quota_exceeded',
      accountRemaining,
      userRemaining,
    };
  }

  if (userPlan && requestedUnits > (userRemaining ?? 0n)) {
    return {
      decision: 'rejected',
      rejectionReason: 'user_quota_exceeded',
      accountRemaining,
      userRemaining,
    };
  }

  return {
    decision: 'accepted',
    accountRemaining: accountRemaining - requestedUnits,
    userRemaining: userPlan ? userRemaining! - requestedUnits : undefined,
  };
}

function clampNonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}
