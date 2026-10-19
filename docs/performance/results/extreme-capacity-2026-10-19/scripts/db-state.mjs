// Capture a compact, read-only snapshot of accounting state from a Postgres
// container. Campaign-only tool (untracked). Never writes.
//
// Usage: node db-state.mjs --container um-extreme-db --out ../snapshots/state.json
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    container: { type: 'string', default: 'um-extreme-db' },
    db: { type: 'string', default: 'usage_metering' },
    out: { type: 'string' },
  },
  strict: true,
});

const SQL = `SELECT json_build_object(
  'captured_at', now(),
  'accounts', (SELECT count(*) FROM accounts),
  'users', (SELECT count(*) FROM users),
  'plans', (SELECT count(*) FROM plans),
  'api_keys', (SELECT count(*) FROM api_keys),
  'usage_requests_total', (SELECT count(*) FROM usage_requests),
  'usage_requests_accepted', (SELECT count(*) FROM usage_requests WHERE decision='accepted'),
  'usage_requests_rejected', (SELECT count(*) FROM usage_requests WHERE decision='rejected'),
  'accepted_units_sum', (SELECT coalesce(sum(units),0)::text FROM usage_requests WHERE decision='accepted'),
  'rejected_units_sum', (SELECT coalesce(sum(units),0)::text FROM usage_requests WHERE decision='rejected'),
  'rejected_with_units_gt_zero', (SELECT count(*) FROM usage_requests WHERE decision='rejected' AND units > 0),
  'account_counters', (SELECT coalesce(json_agg(row_to_json(c) ORDER BY c.account_id, c.period_start), '[]'::json) FROM (
      SELECT account_id::text, period_start::text, counter::text, updated_at FROM usage_counters WHERE user_id IS NULL) c),
  'user_counters', (SELECT coalesce(json_agg(row_to_json(c) ORDER BY c.account_id, c.user_id, c.period_start), '[]'::json) FROM (
      SELECT account_id::text, user_id::text, period_start::text, counter::text FROM usage_counters WHERE user_id IS NOT NULL) c),
  'negative_remainings', (SELECT count(*) FROM usage_requests WHERE account_remaining < 0 OR user_remaining < 0),
  'duplicate_idempotency_keys', (SELECT count(*) FROM (
      SELECT account_id, idempotency_key FROM usage_requests GROUP BY 1,2 HAVING count(*) > 1) d),
  'period_start_mismatches_requests', (SELECT count(*) FROM usage_requests
      WHERE period_start <> (date_trunc('month', created_at AT TIME ZONE 'UTC'))::date),
  'rejected_rows_in_counters_check', (SELECT count(*) FROM usage_requests WHERE decision='rejected' AND units < 0),
  'pg_stat_database', (SELECT row_to_json(p) FROM (
      SELECT xact_commit::text, xact_rollback::text, deadlocks::text, conflicts::text,
             blks_read::text, blks_hit::text, temp_files::text, temp_bytes::text
      FROM pg_stat_database WHERE datname = current_database()) p)
)::text;`;

const raw = execFileSync(
  'docker',
  ['exec', values.container, 'psql', '-U', 'app', '-d', values.db, '-t', '-A', '-c', SQL],
  { encoding: 'utf8', timeout: 15000 }
).trim();

const parsed = JSON.parse(raw);
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(parsed, null, 2));
}
console.log(JSON.stringify(parsed));
