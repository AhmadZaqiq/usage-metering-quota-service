import { ApiClient } from '../apiClient.js';
import type {
  AssignmentDto,
  CurrentAssignmentsDto,
  PlanDto,
  TypedResponse,
  UsageDecisionDto,
  UsageHistoryPageDto,
  UserDto,
} from './types.js';

/**
 * Thin typed wrappers around the shared ApiClient. The simulator performs no
 * HTTP of its own and never imports application services or the database —
 * every call below is exactly one API request documented in docs/API.md.
 */

async function call<T>(
  api: ApiClient,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  options?: { auth?: boolean; keyOverride?: string }
): Promise<TypedResponse<T>> {
  // A guided 12-scenario run legitimately bursts past RATE_LIMIT_MAX; a well-
  // behaved client honors Retry-After instead of failing the whole session.
  // Safe for POST /usage too: the limiter rejects before any quota logic runs,
  // and retries carry the same idempotency key.
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    const res = await api.request(method, path, body, options);
    if (res.status !== 429 || attempt >= MAX_RETRIES) {
      return { status: res.status, data: res.data as unknown as T };
    }
    const waitSeconds = retryAfterSeconds(res.headers['retry-after']);
    console.log(
      `  [throttled] rate limit hit — waiting ${waitSeconds}s before retry (${attempt + 1}/${MAX_RETRIES})`
    );
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
}

/** Retry-After is seconds-until-reset on the normal limiter path; cap at one full window. */
function retryAfterSeconds(header: string | undefined): number {
  const n = Number(header);
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.ceil(n), 60);
  return 1;
}

export function healthReady(api: ApiClient): Promise<TypedResponse<Record<string, unknown>>> {
  return call(api, 'GET', '/health/ready');
}

export function fetchPlans(api: ApiClient): Promise<TypedResponse<PlanDto[]>> {
  return call(api, 'GET', '/plans');
}

export function createPlan(
  api: ApiClient,
  input: { name: string; type: 'account' | 'user'; monthlyAllowance: string; maxUnitsPerRequest: string }
): Promise<TypedResponse<PlanDto>> {
  return call(api, 'POST', '/plans', input);
}

export function patchPlan(
  api: ApiClient,
  planId: number,
  input: { monthlyAllowance?: string; maxUnitsPerRequest?: string; isActive?: boolean }
): Promise<TypedResponse<PlanDto>> {
  return call(api, 'PATCH', `/plans/${planId}`, input);
}

export function fetchUsers(api: ApiClient): Promise<TypedResponse<UserDto[]>> {
  return call(api, 'GET', '/users');
}

export function createUser(api: ApiClient, clientUserId: string): Promise<TypedResponse<UserDto>> {
  return call(api, 'POST', '/users', { clientUserId });
}

export function fetchCurrentAssignments(api: ApiClient): Promise<TypedResponse<CurrentAssignmentsDto>> {
  return call(api, 'GET', '/assignments/current');
}

export function fetchAssignments(api: ApiClient): Promise<TypedResponse<AssignmentDto[]>> {
  return call(api, 'GET', '/assignments');
}

export function createAssignment(
  api: ApiClient,
  input: { planId: number; userId?: string; effectiveFrom?: string }
): Promise<TypedResponse<AssignmentDto>> {
  return call(api, 'POST', '/assignments', input);
}

export function fetchHistory(
  api: ApiClient,
  params: { page?: number; limit?: number; userId?: string } = {}
): Promise<TypedResponse<UsageHistoryPageDto>> {
  const qs = new URLSearchParams();
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.userId !== undefined) qs.set('userId', params.userId);
  const query = qs.toString();
  return call(api, 'GET', query ? `/usage?${query}` : '/usage');
}

export function postUsage(
  api: ApiClient,
  body: { units: string; requestId: string; userId?: string },
  options?: { auth?: boolean; keyOverride?: string }
): Promise<TypedResponse<UsageDecisionDto>> {
  return call<UsageDecisionDto>(api, 'POST', '/usage', body, options);
}
