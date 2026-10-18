export function pgErrorCode(code: string): boolean {
  // SQLSTATE is always five characters: five digits (standard classes) or
  // one letter plus four digits (PL/pgSQL classes such as P0001
  // raise_exception, mapped to a 409 by the error handler).
  return /^\d{5}$/.test(code) || /^[A-Z]\d{4}$/.test(code);
}