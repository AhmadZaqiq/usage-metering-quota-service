export function pgErrorCode(code: string): boolean {
  return /^\d{5}$/.test(code);
}