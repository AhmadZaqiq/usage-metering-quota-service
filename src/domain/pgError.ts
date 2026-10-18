export function pgErrorCode(code: string): boolean {
  // SQLSTATE is exactly five upper-case characters drawn from [0-9A-Z].
  // Both digits-only classes (23505, 40001) and codes with letters in any
  // position (P0001 raise_exception, 40P01 deadlock_detected, HV005...) are
  // valid; a digit/letter-position split would misclassify 40P01 and leave
  // the deadlock branch of the error handler unreachable.
  return /^[0-9A-Z]{5}$/.test(code);
}