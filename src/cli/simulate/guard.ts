import { DemoError } from '../apiClient.js';
import { printError } from './present.js';
import type { TypedResponse } from './types.js';

/**
 * Status guard shared by setup, actions, and scenarios: an unexpected HTTP
 * status is printed with its error body and raised as DemoError, which
 * aborts the current flow instead of letting callers read a typed field off
 * an error payload.
 */
export function expect<T>(res: TypedResponse<T>, status: number, what: string): T {
  if (res.status !== status) {
    printError(res.status, res.data);
    throw new DemoError(`${what}: expected HTTP ${status}, got ${res.status}`);
  }
  return res.data;
}
