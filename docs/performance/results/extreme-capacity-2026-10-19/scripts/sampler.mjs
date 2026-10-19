// Continuous resource + PostgreSQL diagnostic sampler for the campaign.
// Campaign-only tool (untracked). Read-only: docker stats + pg_stat_activity
// / pg_locks queries. Never writes to the database.
//
// Usage: node sampler.mjs --interval 2000 --out ../snapshots/resources.csv
// Reads the current stage label from ../snapshots/current-stage.txt each tick.
// Stop with SIGINT/SIGTERM.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    interval: { type: 'string', default: '2000' },
    out: { type: 'string', default: join(here, '..', 'snapshots', 'resources.csv') },
    stageFile: { type: 'string', default: join(here, '..', 'snapshots', 'current-stage.txt') },
    app: { type: 'string', default: 'um-extreme-app' },
    db: { type: 'string', default: 'um-extreme-db' },
    redis: { type: 'string', default: 'um-extreme-redis' },
  },
  strict: true,
});

const interval = Number(values.interval);
const out = values.out;
const stageFile = values.stageFile;

const HEADER =
  'ts,stage,app_cpu,app_mem,db_cpu,db_mem,redis_cpu,redis_mem,pg_conns,pg_active,' +
  'pg_lock_waiters,pg_ungranted_locks,pg_max_xact_age_s,pg_long_queries_5s,host_load1,gen_cpu_pct';

if (!existsSync(out)) {
  writeFileSync(out, HEADER + '\n');
} else {
  const first = readFileSync(out, 'utf8').split('\n')[0];
  if (first !== HEADER) writeFileSync(out, HEADER + '\n');
}

function stageLabel() {
  try {
    if (existsSync(stageFile)) {
      const s = readFileSync(stageFile, 'utf8').trim();
      if (s) return s;
    }
  } catch {
    /* ignore */
  }
  return '-';
}

function dockerStats() {
  const fmt = '{{.Name}},{{.CPUPerc}},{{.MemUsage}}';
  const raw = execFileSync(
    'docker',
    ['stats', '--no-stream', '--format', fmt, values.app, values.db, values.redis],
    { encoding: 'utf8', timeout: 5000 }
  );
  const map = {};
  for (const line of raw.trim().split('\n')) {
    const [name, cpu, mem] = line.split(',');
    if (!name) continue;
    map[name.trim()] = { cpu: cpu?.trim() ?? '', mem: (mem ?? '').split('/')[0].trim() };
  }
  return map;
}

const PG_SQL = `SELECT
  (SELECT count(*) FROM pg_stat_activity WHERE datname='usage_metering') AS conns,
  (SELECT count(*) FROM pg_stat_activity WHERE datname='usage_metering' AND state='active') AS active,
  (SELECT count(*) FROM pg_stat_activity WHERE datname='usage_metering' AND wait_event_type='Lock') AS lock_waiters,
  (SELECT count(*) FROM pg_locks WHERE NOT granted) AS ungranted,
  (SELECT coalesce(round(max(extract(epoch FROM (now()-xact_start)))::numeric,2),0) FROM pg_stat_activity WHERE datname='usage_metering' AND xact_start IS NOT NULL) AS max_xact_age,
  (SELECT count(*) FROM pg_stat_activity WHERE datname='usage_metering' AND state='active' AND now()-query_start > interval '5 seconds') AS long_queries;`;

function pgStats() {
  const raw = execFileSync(
    'docker',
    ['exec', values.db, 'psql', '-U', 'app', '-d', 'usage_metering', '-t', '-A', '-F', ',', '-c', PG_SQL],
    { encoding: 'utf8', timeout: 5000 }
  ).trim();
  const parts = raw.split(',');
  return {
    conns: parts[0] ?? '',
    active: parts[1] ?? '',
    lockWaiters: parts[2] ?? '',
    ungranted: parts[3] ?? '',
    maxXactAge: parts[4] ?? '',
    longQueries: parts[5] ?? '',
  };
}

function hostLoad1() {
  try {
    return readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
  } catch {
    return '';
  }
}

function generatorCpu() {
  try {
    const raw = execFileSync('bash', ['-c', "ps -C node -o pcpu= 2>/dev/null | awk '{s+=$1} END {print s+0}'"], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return raw.trim();
  } catch {
    return '';
  }
}

let running = true;
function stop() {
  running = false;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(`sampler: writing ${out} every ${interval}ms`);
let ticks = 0;
while (running) {
  const tickStart = Date.now();
  const ts = new Date().toISOString();
  const stage = stageLabel().replaceAll(',', ';');
  try {
    const stats = dockerStats();
    const pg = pgStats();
    const app = stats[values.app] ?? { cpu: '', mem: '' };
    const db = stats[values.db] ?? { cpu: '', mem: '' };
    const redis = stats[values.redis] ?? { cpu: '', mem: '' };
    const line = [
      ts,
      stage,
      app.cpu,
      app.mem,
      db.cpu,
      db.mem,
      redis.cpu,
      redis.mem,
      pg.conns,
      pg.active,
      pg.lockWaiters,
      pg.ungranted,
      pg.maxXactAge,
      pg.longQueries,
      hostLoad1(),
      generatorCpu(),
    ].join(',');
    appendFileSync(out, line + '\n');
    ticks += 1;
  } catch (err) {
    appendFileSync(out, [ts, stage, 'sampler-error', String(err.message).replaceAll(',', ';')].join(',') + '\n');
  }
  const elapsed = Date.now() - tickStart;
  const wait = Math.max(0, interval - elapsed);
  await new Promise((r) => setTimeout(r, wait));
}
console.log(`sampler: stopped after ${ticks} ticks`);
