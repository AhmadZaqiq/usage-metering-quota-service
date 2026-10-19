import { DemoError } from '../apiClient.js';
import {
  createAssignment,
  createPlan,
  fetchAssignments,
  fetchHistory,
  fetchPlans,
  fetchUsers,
  healthReady,
  patchPlan,
  postUsage,
} from './api.js';
import type { SimContext } from './context.js';
import { expect } from './guard.js';
import { EofError } from './menu.js';
import {
  fmtConsumed,
  fmtStamp,
  printBlock,
  printChanged,
  printDecision,
  printError,
  printHistoryPage,
  printNote,
  printOk,
  printSection,
  renderTable,
} from './present.js';
import { SCENARIOS, runScenario } from './scenarios/index.js';
import { isSimcoUser, loadSnapshot, remainingOf } from './snapshot.js';

const HISTORY_PAGE_SIZE = 10;

export async function showDashboard(ctx: SimContext): Promise<void> {
  const ready = await healthReady(ctx.api);
  const snap = await loadSnapshot(ctx.api);
  printSection(`Company dashboard — ${ctx.companyName}`);
  const currentMonth = `${new Date().toISOString().slice(0, 7)}-01`;
  const latest = snap.accountLatest;
  const header = [
    ['target', ctx.baseUrl],
    ['api key', ctx.maskedKey],
    ['service', ready.status === 200 ? 'ready' : `NOT ready (HTTP ${ready.status})`],
    ['billing period', `${currentMonth} (UTC)`],
  ];
  printBlock(header.map(([k, v]) => `${k.padEnd(15)}${v}`).join('\n'));

  printSection('Account quota');
  if (snap.current !== null && snap.accountPlan !== null) {
    const plan = snap.accountPlan;
    const scope = plan.ownerAccountId === null ? 'system (read-only)' : 'custom';
    const remaining = latest?.accountRemaining ?? null;
    const kv = [
      ['plan', `${plan.name} (id ${plan.id}, ${scope})`],
      ['allowance', plan.monthlyAllowance],
      ['max/request', plan.maxUnitsPerRequest],
      ['remaining', remaining ?? '— unknown until the first request'],
      ['consumed', remaining === null ? '—' : fmtConsumed(plan.monthlyAllowance, remaining)],
      ['as of', fmtStamp(latest?.createdAt ?? null)],
    ];
    printBlock(kv.map(([k, v]) => `${k.padEnd(15)}${v}`).join('\n'));
    if (latest !== null && latest.periodStart !== currentMonth) {
      printNote(`latest recorded request was in ${latest.periodStart}, not the current month`);
    }
    if (remaining === null) {
      printNote('no usage recorded yet — remaining and consumed appear after the first request');
    } else {
      printNote('remaining/consumed reflect the latest recorded request; the next request refreshes them');
    }
  } else {
    printNote('no account plan assigned — POST /usage returns 409; activate one via menu 7');
  }

  printSection('Company users (simco-*)');
  const simco = snap.userSnapshots.filter((s) => isSimcoUser(s.user.clientUserId));
  const rows = simco.map((s) => {
    const remaining = remainingOf(s.latest, 'user');
    return [
      s.user.clientUserId,
      s.plan?.name ?? '(no plan)',
      s.plan?.monthlyAllowance ?? '—',
      remaining ?? '—',
      remaining !== null && s.plan !== null ? fmtConsumed(s.plan.monthlyAllowance, remaining) : '—',
      fmtStamp(s.latest?.createdAt ?? null),
    ];
  });
  printBlock(
    renderTable(['user', 'plan', 'allowance', 'remaining', 'consumed', 'as of'], rows, ['l', 'l', 'r', 'r', 'r', 'l'])
  );
  const others = snap.userSnapshots.length - simco.length;
  if (others > 0) {
    printNote(`${others} other user(s) in this account (demo runs create demo-* users) — see menu 2`);
  }
}

export async function showUsers(ctx: SimContext): Promise<void> {
  const snap = await loadSnapshot(ctx.api);
  printSection('Users & balances');
  const rows = snap.userSnapshots.map((s) => [
    s.user.clientUserId,
    isSimcoUser(s.user.clientUserId) ? 'company' : 'other',
    s.user.isActive ? 'active' : 'inactive',
    s.plan?.name ?? '(no plan)',
    s.plan?.monthlyAllowance ?? '—',
    remainingOf(s.latest, 'user') ?? '—',
    fmtStamp(s.latest?.createdAt ?? null),
  ]);
  printBlock(
    renderTable(
      ['user', 'scope', 'status', 'plan', 'allowance', 'remaining', 'last activity'],
      rows,
      ['l', 'l', 'l', 'l', 'r', 'r', 'l']
    )
  );
  printNote("remaining/last activity shown for company users (simco-*); others show — — simulate an action to refresh");
}

export async function simulateAction(ctx: SimContext): Promise<void> {
  const snap = await loadSnapshot(ctx.api);
  printSection('Simulate action — consume units');
  const options: { label: string; userId?: string }[] = [
    { label: 'account-scoped (draws from the account pool only)' },
  ];
  for (const s of snap.userSnapshots) {
    options.push({
      userId: s.user.clientUserId,
      label: `${s.user.clientUserId} — ${s.plan?.name ?? 'no plan'} (remaining ${remainingOf(s.latest, 'user') ?? '?'})`,
    });
  }
  printBlock(options.map((o, i) => `${i}) ${o.label}`).join('\n'));
  const pick = await ctx.menu.choice('  Select (0 = account scope): ', 0, options.length - 1);
  const selected = options[pick];
  const units = await ctx.menu.positiveInt('  Units to consume: ');
  const requestId = ctx.nextRequestId('act');
  const res = await postUsage(ctx.api, {
    units,
    requestId,
    ...(selected.userId !== undefined ? { userId: selected.userId } : {}),
  });
  printDecision(res);
  if (res.status === 200) {
    printNote(`requestId ${requestId} — resending the identical payload replays this result (scenarios 9/10)`);
  }
}

export async function showAssignments(ctx: SimContext): Promise<void> {
  const assignments = expect(await fetchAssignments(ctx.api), 200, 'list assignments');
  const users = expect(await fetchUsers(ctx.api), 200, 'list users');
  printSection('Plan assignments (current + history)');
  const rows = assignments.map((a) => [
    a.userId === null ? '(account)' : (users.find((u) => u.id === a.userId)?.clientUserId ?? `#${String(a.userId)}`),
    a.planName,
    a.planType,
    fmtStamp(a.effectiveFrom),
    a.effectiveTo === null ? '—' : fmtStamp(a.effectiveTo),
    a.isCurrent ? 'current' : 'closed',
  ]);
  printBlock(
    renderTable(['subject', 'plan', 'type', 'effective from', 'effective to', 'state'], rows, [
      'l',
      'l',
      'l',
      'l',
      'l',
      'l',
    ])
  );
  printNote('history rows are never deleted; a new assignment closes the previous one immediately');
}

export async function showPlans(ctx: SimContext): Promise<void> {
  const plans = expect(await fetchPlans(ctx.api), 200, 'list plans');
  printSection('Plans (system + your custom plans)');
  const rows = plans.map((p) => [
    String(p.id),
    p.name,
    p.type,
    p.ownerAccountId === null ? 'system' : 'custom',
    p.monthlyAllowance,
    p.maxUnitsPerRequest,
    p.isActive ? 'yes' : 'no',
  ]);
  printBlock(
    renderTable(['id', 'name', 'type', 'scope', 'allowance', 'max/request', 'active'], rows, [
      'r',
      'l',
      'l',
      'l',
      'r',
      'r',
      'l',
    ])
  );
  printNote('system plans are read-only (403 on PATCH); update your custom plans via menu 9');
}

export async function changeUserPlan(ctx: SimContext): Promise<void> {
  const snap = await loadSnapshot(ctx.api);
  printSection('Change user plan');
  if (snap.userSnapshots.length === 0) {
    printNote('no users in this account');
    return;
  }
  const userRows = snap.userSnapshots.map((s, i) => [
    String(i + 1),
    s.user.clientUserId,
    s.plan?.name ?? '(no plan)',
  ]);
  printBlock(renderTable(['#', 'user', 'current plan'], userRows, ['r', 'l', 'l']));
  const userPick = await ctx.menu.choice('  Select user (0 = cancel): ', 0, userRows.length);
  if (userPick === 0) return;
  const target = snap.userSnapshots[userPick - 1];

  const userPlans = snap.plans.filter((p) => p.type === 'user' && p.isActive);
  const planRows = userPlans.map((p, i) => [
    String(i + 1),
    p.name,
    p.monthlyAllowance,
    p.maxUnitsPerRequest,
    target.assignment?.planId === p.id ? '<- current' : '',
  ]);
  printBlock(renderTable(['#', 'plan', 'allowance', 'max/request', ''], planRows, ['r', 'l', 'r', 'r', 'l']));
  const planPick = await ctx.menu.choice('  Select plan (0 = cancel): ', 0, planRows.length);
  if (planPick === 0) return;
  const plan = userPlans[planPick - 1];
  if (target.assignment?.planId === plan.id) {
    printOk(`${target.user.clientUserId} is already on ${plan.name}`);
    return;
  }
  const go = await ctx.menu.yesNo(
    `  Assign "${plan.name}" to ${target.user.clientUserId}? (effective on the next request)`,
    false
  );
  if (!go) return;
  expect(
    await createAssignment(ctx.api, { userId: target.user.clientUserId, planId: plan.id }),
    201,
    'assign user plan'
  );
  printChanged(`${target.user.clientUserId} → ${plan.name} (effective immediately)`);
}

export async function changeAccountPlan(ctx: SimContext): Promise<void> {
  const snap = await loadSnapshot(ctx.api);
  printSection('Change account plan');
  printBlock(`  Current: ${snap.current?.planName ?? 'no account plan (requests fail with 409)'}`);
  const accountPlans = snap.plans.filter((p) => p.type === 'account' && p.isActive);
  const rows = accountPlans.map((p, i) => [
    String(i + 1),
    p.name,
    p.ownerAccountId === null ? 'system' : 'custom',
    p.monthlyAllowance,
    p.maxUnitsPerRequest,
    snap.current?.planId === p.id ? '<- current' : '',
  ]);
  printBlock(renderTable(['#', 'plan', 'scope', 'allowance', 'max/request', ''], rows, ['r', 'l', 'l', 'r', 'r', 'l']));
  printNote('choosing a non-current plan here also restores a previous one (including at exit)');
  const pick = await ctx.menu.choice('  Select plan (0 = cancel): ', 0, rows.length);
  if (pick === 0) return;
  const plan = accountPlans[pick - 1];
  if (snap.current?.planId === plan.id) {
    printOk(`${plan.name} is already the active account plan`);
    return;
  }
  const go = await ctx.menu.yesNo(
    `  Assign "${plan.name}" as the ACCOUNT plan? Every request draws from this quota.`,
    false
  );
  if (!go) return;
  expect(await createAssignment(ctx.api, { planId: plan.id }), 201, 'assign account plan');
  printChanged(`account plan → ${plan.name} (effective immediately)`);
}

export async function createCustomPlan(ctx: SimContext): Promise<void> {
  printSection('Create custom plan');
  const name = (await ctx.menu.text('  Plan name: ')).slice(0, 100);
  if (name === '') {
    printNote('empty name — nothing created');
    return;
  }
  const typePick = await ctx.menu.choice('  Type: 1 = account, 2 = user: ', 1, 2);
  const monthlyAllowance = await ctx.menu.positiveInt('  Monthly allowance (units): ');
  const maxUnitsPerRequest = await ctx.menu.positiveInt('  Max units per request: ');
  const res = await createPlan(ctx.api, {
    name,
    type: typePick === 1 ? 'account' : 'user',
    monthlyAllowance,
    maxUnitsPerRequest,
  });
  if (res.status === 201) {
    printChanged(`created plan "${res.data.name}" (id ${String(res.data.id)}, allowance ${res.data.monthlyAllowance}, max/request ${res.data.maxUnitsPerRequest})`);
  } else {
    printError(res.status, res.data);
  }
}

export async function updateCustomPlan(ctx: SimContext): Promise<void> {
  const plans = expect(await fetchPlans(ctx.api), 200, 'list plans');
  const custom = plans.filter((p) => p.ownerAccountId !== null && p.isActive);
  printSection('Update custom plan');
  if (custom.length === 0) {
    printNote('no custom plans yet — create one with menu 8');
    return;
  }
  const rows = custom.map((p, i) => [
    String(i + 1),
    p.name,
    p.type,
    p.monthlyAllowance,
    p.maxUnitsPerRequest,
  ]);
  printBlock(renderTable(['#', 'plan', 'type', 'allowance', 'max/request'], rows, ['r', 'l', 'l', 'r', 'r']));
  const pick = await ctx.menu.choice('  Select plan (0 = cancel): ', 0, rows.length);
  if (pick === 0) return;
  const plan = custom[pick - 1];

  let monthlyAllowance: string | undefined;
  for (;;) {
    const raw = (await ctx.menu.text(`  New monthly allowance (current ${plan.monthlyAllowance}; Enter keeps): `)).trim();
    if (raw === '') break;
    if (/^[1-9]\d*$/.test(raw)) {
      monthlyAllowance = raw;
      break;
    }
    printNote('enter a positive whole number, or press Enter to keep the current value');
  }
  let maxUnitsPerRequest: string | undefined;
  for (;;) {
    const raw = (await ctx.menu.text(`  New max/request (current ${plan.maxUnitsPerRequest}; Enter keeps): `)).trim();
    if (raw === '') break;
    if (/^[1-9]\d*$/.test(raw)) {
      maxUnitsPerRequest = raw;
      break;
    }
    printNote('enter a positive whole number, or press Enter to keep the current value');
  }

  if (monthlyAllowance === undefined && maxUnitsPerRequest === undefined) {
    printNote('nothing changed');
    return;
  }
  if (monthlyAllowance !== undefined && BigInt(monthlyAllowance) < BigInt(plan.monthlyAllowance)) {
    const go = await ctx.menu.yesNo(
      `  Lower allowance ${plan.monthlyAllowance} → ${monthlyAllowance}? Remaining clamps at 0 if usage is higher.`,
      false
    );
    if (!go) {
      printNote('nothing changed');
      return;
    }
  }
  const updated = expect(
    await patchPlan(ctx.api, plan.id, {
      ...(monthlyAllowance !== undefined ? { monthlyAllowance } : {}),
      ...(maxUnitsPerRequest !== undefined ? { maxUnitsPerRequest } : {}),
    }),
    200,
    'update plan'
  );
  printChanged(
    `updated ${updated.name}: allowance ${updated.monthlyAllowance}, max/request ${updated.maxUnitsPerRequest}`
  );
}

export async function browseHistory(ctx: SimContext): Promise<void> {
  printSection('Usage history (paginated)');
  let page = 1;
  let filterUserId: string | undefined;
  for (;;) {
    const res = await fetchHistory(ctx.api, {
      page,
      limit: HISTORY_PAGE_SIZE,
      ...(filterUserId !== undefined ? { userId: filterUserId } : {}),
    });
    if (res.status === 404 && filterUserId !== undefined) {
      printError(res.status, res.data);
      printNote('unknown filter user — cleared');
      filterUserId = undefined;
      continue;
    }
    const data = expect(res, 200, 'read history');
    printHistoryPage(data, filterUserId !== undefined ? `· user=${filterUserId}` : '');
    const choice = await ctx.menu.choice(
      '  [1] next  [2] prev  [3] filter by user  [4] clear filter  [0] back: ',
      0,
      4
    );
    if (choice === 0) return;
    if (choice === 1) {
      if (data.total === 0) printNote('no rows to page through');
      else if (page < data.totalPages) page += 1;
      else printNote('already on the last page');
    } else if (choice === 2) {
      if (page > 1) page -= 1;
      else printNote('already on the first page');
    } else if (choice === 3) {
      const users = expect(await fetchUsers(ctx.api), 200, 'list users');
      const rows = users.map((u, i) => [String(i + 1), u.clientUserId]);
      printBlock(renderTable(['#', 'user'], rows, ['r', 'l']));
      const userPick = await ctx.menu.choice('  Filter to user (0 = cancel): ', 0, rows.length);
      if (userPick > 0) {
        filterUserId = users[userPick - 1].clientUserId;
        page = 1;
      }
    } else {
      filterUserId = undefined;
      page = 1;
    }
  }
}

export async function guidedScenarios(ctx: SimContext): Promise<void> {
  for (;;) {
    printSection('Guided scenarios');
    printBlock(renderTable(['#', 'scenario'], SCENARIOS.map((s) => [String(s.n), s.title]), ['r', 'l']));
    const n = await ctx.menu.choice('  Run scenario (0 = back): ', 0, SCENARIOS.length);
    if (n === 0) return;
    await runScenario(ctx, SCENARIOS[n - 1]);
  }
}

const ACTIONS = [
  showDashboard,
  showUsers,
  simulateAction,
  showAssignments,
  showPlans,
  changeUserPlan,
  changeAccountPlan,
  createCustomPlan,
  updateCustomPlan,
  browseHistory,
  guidedScenarios,
];

const MENU_LINES = [
  '  1) Company dashboard            7) Change account plan',
  '  2) Users & balances             8) Create custom plan',
  '  3) Simulate action (consume)    9) Update custom plan',
  '  4) Plan assignments            10) Usage history (paginated)',
  '  5) Plans (list)                11) Guided scenarios (12)',
  '  6) Change user plan             0) Exit',
];

/**
 * Menu loop: render, read a choice, dispatch. A per-action DemoError
 * (service unreachable, unexpected status) returns to the menu; EofError
 * ends the session. Dispatch is data — interaction lives in the actions.
 */
export async function runMenu(ctx: SimContext): Promise<void> {
  for (;;) {
    printSection(`${ctx.companyName} — usage metering simulator`);
    console.log(MENU_LINES.join('\n'));
    const choice = await ctx.menu.choice('  Choose (0-11): ', 0, ACTIONS.length);
    if (choice === 0) return;
    try {
      await ACTIONS[choice - 1](ctx);
    } catch (err) {
      if (err instanceof EofError) throw err;
      if (err instanceof DemoError) {
        console.log(`  [error] ${err.message}`);
        continue;
      }
      throw err;
    }
  }
}
