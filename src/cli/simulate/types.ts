/**
 * Wire shapes the simulator reads from the service, transcribed from the
 * serializers in src/presentation/routes/*.ts. BigInt values arrive as
 * string-encoded decimals (never JSON numbers).
 */

export interface PlanDto {
  id: number;
  name: string;
  type: 'account' | 'user';
  ownerAccountId: number | null;
  monthlyAllowance: string;
  maxUnitsPerRequest: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserDto {
  id: number;
  clientUserId: string;
  isActive: boolean;
  createdAt: string;
}

export interface AssignmentDto {
  id: number;
  accountId: number;
  userId: number | null;
  planId: number;
  planName: string;
  planType: 'account' | 'user';
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export interface CurrentAssignmentsDto {
  account: AssignmentDto | null;
  users: AssignmentDto[];
}

export interface UsageHistoryItemDto {
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

export interface UsageHistoryPageDto {
  items: UsageHistoryItemDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface UsageDecisionDto {
  decision: string;
  accountRemaining: string;
  periodStart: string;
  userRemaining?: string;
  rejectionReason?: string;
  limitScope?: string;
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

/** A non-2xx `data` is an error body — read T fields only after checking status. */
export interface TypedResponse<T> {
  status: number;
  data: T;
}
