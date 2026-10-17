export function getUtcMonthStart(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function getNextUtcMonthStart(date: Date = new Date()): Date {
  const monthStart = getUtcMonthStart(date);
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

export function formatDateForDb(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function isSameUtcMonth(d1: Date, d2: Date): boolean {
  return d1.getUTCFullYear() === d2.getUTCFullYear() && d1.getUTCMonth() === d2.getUTCMonth();
}