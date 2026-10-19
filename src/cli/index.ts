/**
 * Example tenant client.
 *
 * Commands:
 *  - demo (default): runs an end-to-end scenario walkthrough against a
 *    running service — health gate, accepted usage, user/account/per-request
 *    rejections, immediate plan changes, idempotent replay, credential and
 *    input rejections, history + assignment summary. Output is deterministic
 *    because the demo normalizes plan allowances before asserting remainings.
 *    When DATABASE_URL is set, a successful demo finishes by verifying the
 *    accounting invariants in-process.
 *  - consume: send one POST /usage request (legacy -n/-i flags map through).
 *  - usage --userId: GET /usage filtered to a single user.
 *  - history: GET /usage, paginated.
 *
 * Exit codes: 0 = success, 1 = failure. The full API key is never printed;
 * only the public prefix is shown.
 */
import { parseOptions, requireKey } from './options.js';
import { runConsume } from './commands/consume.js';
import { runUsage } from './commands/usage.js';
import { runHistory } from './commands/history.js';
import { runDemo } from './demo/scenario.js';

/**
 * Verify accounting invariants in-process after a successful demo. Skipped
 * (not failed) when DATABASE_URL is unset, because verify-invariants connects
 * to PostgreSQL directly — importing it without the env would throw.
 */
async function runInvariantStep(): Promise<{ ran: boolean; ok: boolean }> {
  if (!process.env.DATABASE_URL) {
    console.log('  Invariant check skipped: DATABASE_URL not set.');
    return { ran: false, ok: true };
  }
  try {
    const { verify } = await import('../scripts/verify-invariants.js');
    const violations = await verify(process.env.BOOTSTRAP_ACCOUNT_NAME);
    if (violations.length > 0) {
      console.error(`\n${violations.length} invariant violation(s):`);
      for (const v of violations) {
        console.error(`  [${v.check}] ${v.detail}`);
      }
      return { ran: true, ok: false };
    }
    return { ran: true, ok: true };
  } catch (err) {
    console.error(`Invariant check failed to run: ${(err as Error).message}`);
    return { ran: true, ok: false };
  }
}

async function main(): Promise<number> {
  const opts = parseOptions();
  const key = requireKey(opts);

  switch (opts.command) {
    case 'consume':
      return await runConsume(opts, key);
    case 'usage':
      return await runUsage(opts, key);
    case 'history':
      return await runHistory(opts, key);
    case 'demo':
    default: {
      const demoCode = await runDemo(opts, key);
      if (demoCode !== 0) {
        return demoCode;
      }
      console.log('All demo assertions passed.');

      const invariants = await runInvariantStep();
      if (!invariants.ran) {
        return 0;
      }
      if (!invariants.ok) {
        return 1;
      }
      console.log('All accounting invariants passed.');
      return 0;
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Client failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
