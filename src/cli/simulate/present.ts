import { ApiErrorBody, TypedResponse, UsageDecisionDto, UsageHistoryPageDto } from './types.js';

/**
 * Presentation only: pure formatting over already-fetched data. No network,
 * no prompts, no business rules — callers fetch and decide, this file prints.
 */

type Align = 'l' | 'r';

export function renderTable(headers: string[], rows: string[][], aligns?: Align[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))
  );
  const cell = (text: string, i: number): string => {
    const width = widths[i] ?? text.length;
    return aligns?.[i] === 'r' ? text.padStart(width) : text.padEnd(width);
  };
  const line = (cells: string[]): string => cells.map((c, i) => cell(c, i)).join('  ').trimEnd();
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

export function printBlock(text: string): void {
  console.log(text.split('\n').map((l) => `  ${l}`).join('\n'));
}

export function printSection(title: string): void {
  console.log(`\n--- ${title} ---`);
}

export function printChanged(msg: string): void {
  console.log(`  [changed] ${msg}`);
}

export function printNote(msg: string): void {
  console.log(`  [note] ${msg}`);
}

export function printOk(msg: string): void {
  console.log(`  [ok] ${msg}`);
}

export function printError(status: number, data: unknown): void {
  const body = data as ApiErrorBody | undefined;
  const err = body?.error;
  if (err?.code || err?.message) {
    const detail =
      err.details !== undefined && err.details !== null && Object.keys(err.details).length > 0
        ? ` ${JSON.stringify(err.details)}`
        : '';
    console.log(`  [error] HTTP ${status} ${err.code ?? ''} — ${err.message ?? ''}${detail}`.trimEnd());
    return;
  }
  console.log(`  [error] HTTP ${status} — ${JSON.stringify(data).slice(0, 300)}`);
}

/** Business rejections are HTTP 200; transport failures are not. */
export function printDecision(res: TypedResponse<UsageDecisionDto>): void {
  if (res.status !== 200) {
    printError(res.status, res.data);
    return;
  }
  const d = res.data;
  const rows: string[][] = [['decision', d.decision]];
  if (d.rejectionReason) rows.push(['rejectionReason', d.rejectionReason]);
  if (d.limitScope) rows.push(['limitScope', d.limitScope]);
  rows.push(['accountRemaining', d.accountRemaining]);
  if (d.userRemaining !== undefined) rows.push(['userRemaining', d.userRemaining]);
  rows.push(['periodStart', d.periodStart]);
  printBlock(rows.map(([k, v]) => `${k.padEnd(18)}${v}`).join('\n'));
}

export function printHistoryPage(page: UsageHistoryPageDto, filterNote = ''): void {
  if (page.items.length === 0) {
    console.log(`  (no usage rows${filterNote ? ` ${filterNote}` : ''})`);
    return;
  }
  const rows = page.items.map((item) => [
    item.createdAt.slice(0, 19).replace('T', ' '),
    item.requestId.length > 30 ? `${item.requestId.slice(0, 29)}…` : item.requestId,
    item.userId ?? '(account)',
    item.units,
    item.decision,
    item.rejectionReason ?? '',
    item.accountRemaining ?? '-',
    item.userRemaining ?? '-',
  ]);
  printBlock(
    renderTable(
      ['time (UTC)', 'requestId', 'user', 'units', 'decision', 'reason', 'acctRem', 'userRem'],
      rows,
      ['l', 'l', 'l', 'r', 'l', 'l', 'r', 'r']
    )
  );
  console.log(
    `  Page ${page.page}/${page.totalPages} — ${page.total} row(s)${filterNote ? ` ${filterNote}` : ''} (rejected requests are kept for audit)`
  );
}

/**
 * Quota math for display only. A negative result means the allowance was
 * lowered after the row was recorded — the row no longer describes reality.
 */
export function fmtConsumed(allowance: string, remaining: string): string {
  const consumed = BigInt(allowance) - BigInt(remaining);
  if (consumed < 0n) return '— (plan changed since)';
  return consumed.toString();
}

export function fmtStamp(iso: string | null): string {
  if (!iso) return '—';
  return `${iso.slice(0, 19).replace('T', ' ')}Z`;
}
