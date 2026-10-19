import { DemoError } from '../../apiClient.js';
import type { SimContext } from '../context.js';
import { s12HistoryPagination } from './ops.js';
import { s11ValidationAndAuthErrors, s10IdempotencyConflict, s9IdempotentRetry } from './reliability.js';
import {
  s1SuccessfulConsumption,
  s2UserQuotaExceeded,
  s3AccountQuotaExceeded,
  s4MaxUnitsPerRequest,
  s5SharedAccountUsage,
  s6DifferentUserPlans,
  s7PlanChangeImmediate,
  s8AllowanceBelowUsage,
} from './quota.js';

export interface Scenario {
  n: number;
  title: string;
  run: (ctx: SimContext) => Promise<void>;
}

/** The 12 required demo scenarios, in menu order. */
export const SCENARIOS: Scenario[] = [
  { n: 1, title: 'Successful consumption', run: s1SuccessfulConsumption },
  { n: 2, title: 'User quota exceeded', run: s2UserQuotaExceeded },
  { n: 3, title: 'Account quota exceeded', run: s3AccountQuotaExceeded },
  { n: 4, title: 'Max units per request', run: s4MaxUnitsPerRequest },
  { n: 5, title: 'Shared account usage', run: s5SharedAccountUsage },
  { n: 6, title: 'Different user plans', run: s6DifferentUserPlans },
  { n: 7, title: 'Plan change takes effect immediately', run: s7PlanChangeImmediate },
  { n: 8, title: 'Allowance reduced below usage', run: s8AllowanceBelowUsage },
  { n: 9, title: 'Idempotent retry', run: s9IdempotentRetry },
  { n: 10, title: 'Idempotency key conflict', run: s10IdempotencyConflict },
  { n: 11, title: 'Validation and auth errors', run: s11ValidationAndAuthErrors },
  { n: 12, title: 'Usage history and pagination', run: s12HistoryPagination },
];

/**
 * A declined scenario precondition (or a skipped activation) is reported as
 * a skip, not a crash; genuine failures still propagate to the menu loop.
 */
export async function runScenario(ctx: SimContext, scenario: Scenario): Promise<void> {
  try {
    await scenario.run(ctx);
  } catch (err) {
    if (err instanceof DemoError) {
      console.log(`  [skipped] ${err.message}`);
      return;
    }
    throw err;
  }
}
