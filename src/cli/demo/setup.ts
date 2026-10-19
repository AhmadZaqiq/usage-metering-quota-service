import { ApiClient, DemoError } from '../apiClient.js';
import type { ScenarioReport } from '../output.js';

export const PROBE_ALLOWANCE = 1_000_000n;

export async function healthGate(api: ApiClient, report: ScenarioReport): Promise<void> {
  const ready = await api.request('GET', '/health/ready');
  report.expect(
    'service is ready (/health/ready = 200)',
    ready.status === 200,
    `got ${ready.status}`
  );
}

export async function ensureUserPlan(
  api: ApiClient,
  report: ScenarioReport,
  plans: {
    id: number;
    name: string;
    type: string;
    ownerAccountId: number | null;
    monthlyAllowance: string;
    maxUnitsPerRequest: string;
  }[],
  name: string,
  monthlyAllowance: string,
  maxUnitsPerRequest: string
): Promise<{ planId: number }> {
  const existing = plans.find((p) => p.type === 'user' && p.name === name);
  if (!existing) {
    const created = await api.request('POST', '/plans', {
      name,
      type: 'user',
      monthlyAllowance,
      maxUnitsPerRequest,
    });
    report.expect(`created ${name}`, created.status === 201, `got ${created.status}`);
    return { planId: (created.data as unknown as { id: number }).id };
  }

  const patched = await api.request('PATCH', `/plans/${existing.id}`, {
    monthlyAllowance,
    maxUnitsPerRequest,
  });
  report.expect(`normalized ${name} allowances`, patched.status === 200, `got ${patched.status}`);
  return { planId: existing.id };
}

export async function ensureDemoPlansAndUsers(
  api: ApiClient,
  report: ScenarioReport,
  runId: string
): Promise<{
  userIds: string[];
  accountPlanId: number;
  userPlanId: number;
  plusPlanId: number;
}> {
  const userIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const clientUserId = `demo-${runId}-${i}`;
    const res = await api.request('POST', '/users', { clientUserId });
    report.expect(`created demo user ${clientUserId}`, res.status === 201, `got ${res.status}`);
    userIds.push(clientUserId);
  }

  const plansRes = await api.request('GET', '/plans');
  report.expect('listed plans', plansRes.status === 200, `got ${plansRes.status}`);
  const plans = plansRes.data as unknown as {
    id: number;
    name: string;
    type: string;
    ownerAccountId: number | null;
    monthlyAllowance: string;
    maxUnitsPerRequest: string;
  }[];

  const userPlans = await ensureUserPlan(api, report, plans, 'Demo User Plan', '100', '10');
  // Plus plan: same setup but a higher allowance and a higher per-request cap,
  // so demo-3 accepts units demo-1/demo-2 would reject (per-plan decision).
  const plusPlans = await ensureUserPlan(api, report, plans, 'Demo User Plan Plus', '200', '20');

  // demo-1 and demo-2 share the small user plan; demo-3 gets the Plus plan so
  // the same units yield different remainings and different accept/reject.
  const smallAssign = await api.request('POST', '/assignments', {
    userId: userIds[0],
    planId: userPlans.planId,
  });
  report.expect(
    `assigned Demo User Plan to ${userIds[0]}`,
    smallAssign.status === 201,
    `got ${smallAssign.status}`
  );
  const smallAssign2 = await api.request('POST', '/assignments', {
    userId: userIds[1],
    planId: userPlans.planId,
  });
  report.expect(
    `assigned Demo User Plan to ${userIds[1]}`,
    smallAssign2.status === 201,
    `got ${smallAssign2.status}`
  );
  const plusAssign = await api.request('POST', '/assignments', {
    userId: userIds[2],
    planId: plusPlans.planId,
  });
  report.expect(
    `assigned Demo User Plan Plus to ${userIds[2]}`,
    plusAssign.status === 201,
    `got ${plusAssign.status}`
  );

  const currentRes = await api.request('GET', '/assignments/current');
  report.expect('read current assignments', currentRes.status === 200, `got ${currentRes.status}`);
  const current = currentRes.data as unknown as { account: { planId: number } | null };
  report.expect('an account plan is currently assigned', current.account !== null);
  const assignedPlanId = current.account.planId;

  let accountPlan: { id: number; ownerAccountId: number | null } | undefined = plans.find(
    (p) => p.id === assignedPlanId
  );

  if (accountPlan && accountPlan.ownerAccountId === null) {
    // System plans are immutable by design: switch to an account-owned plan.
    const existingDemoPlan = plans.find(
      (p) => p.type === 'account' && p.name === 'Demo Account Plan'
    );
    if (existingDemoPlan) {
      accountPlan = existingDemoPlan;
    } else {
      const created = await api.request('POST', '/plans', {
        name: 'Demo Account Plan',
        type: 'account',
        monthlyAllowance: String(PROBE_ALLOWANCE),
        maxUnitsPerRequest: '1000',
      });
      report.expect('created Demo Account Plan', created.status === 201, `got ${created.status}`);
      accountPlan = created.data as unknown as { id: number; ownerAccountId: number | null };
    }
    const assigned = await api.request('POST', '/assignments', { planId: accountPlan.id });
    report.expect('assigned Demo Account Plan', assigned.status === 201, `got ${assigned.status}`);
  }

  report.expect(
    'account plan is account-owned (mutable)',
    accountPlan !== undefined && accountPlan.ownerAccountId !== null
  );

  const normalized = await api.request('PATCH', `/plans/${accountPlan.id}`, {
    monthlyAllowance: String(PROBE_ALLOWANCE),
  });
  report.expect(
    'normalized account plan allowance for deterministic math',
    normalized.status === 200,
    `got ${normalized.status}`
  );

  return { userIds, accountPlanId: accountPlan.id, userPlanId: userPlans.planId, plusPlanId: plusPlans.planId };
}

export async function probeUsed(api: ApiClient, report: ScenarioReport, runId: string): Promise<bigint> {
  const probe = await api.request('POST', '/usage', {
    units: '1',
    requestId: `demo-probe-${runId}`,
  });
  if (probe.status !== 200 || probe.data.decision !== 'accepted') {
    throw new DemoError(
      `Probe request failed (status ${probe.status}, decision ${String(probe.data.decision)}): cannot establish current usage`
    );
  }
  const remaining = BigInt(String(probe.data.accountRemaining));
  report.expect('probe request accepted', true, `accountRemaining=${remaining}`);
  // accountRemaining in an accepted response is the balance AFTER the
  // probe's own consumption, so current usage = allowance - remaining.
  return PROBE_ALLOWANCE - remaining;
}
