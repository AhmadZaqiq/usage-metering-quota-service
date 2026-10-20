export function pgErrorCode(code: string): boolean {
  // SQLSTATE is exactly five upper-case characters drawn from [0-9A-Z].
  // Both digits-only classes (23505, 40001) and codes with letters in any
  // position (P0001 raise_exception, 40P01 deadlock_detected, HV005...) are
  // valid; a digit/letter-position split would misclassify 40P01 and leave
  // the deadlock branch of the error handler unreachable.
  return /^[0-9A-Z]{5}$/.test(code);
}

/**
 * drizzle-orm >= 0.44 wraps every failed query in an error shaped
 * { message: "Failed query: ...", query, params, cause } where `cause` is the
 * original driver error (bearing SQLSTATE `code`, `constraint`, etc.).
 * 0.33 threw the driver error directly. Every consumer that inspects
 * `err.code` must unwrap first so behavior stays identical across versions.
 */
export function unwrapQueryError(err: unknown): unknown {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; cause?: unknown };
    if (e.code === undefined && e.cause && typeof e.cause === "object") {
      return e.cause;
    }
  }
  return err;
}