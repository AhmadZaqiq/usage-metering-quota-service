import { parseArgs } from 'util';
import * as fs from 'fs';

export const DEFAULT_KEY_FILE = '/run/secrets/api-key';
export const DEFAULT_BASE_URL = 'http://localhost:3000';

const HELP = `Usage: client [command] [options]

Commands:
  demo                       Run the end-to-end demo scenario walkthrough (default).
                             With DATABASE_URL set, also verifies accounting invariants.
  consume                    Send one POST /usage request.
      --userId <id>          clientUserId (optional; omitted = account-scoped request)
  -n, --units <units>        Positive integer units, string form (required)
  -i, --requestId <key>      Client idempotency key; send the same value to retry (required)
                             --idempotencyKey is accepted as a deprecated alias for -i
  usage                      GET /usage filtered to one user.
      --userId <id>          clientUserId to filter by (required)
      --page <n>             Page number (default 1)
      --limit <n>            Page size (default 50)
  history                    GET /usage, paginated.
      --page <n>             Page number (default 1)
      --limit <n>            Page size (default 50)
  simulate                   Interactive company simulator: menu-driven walkthrough of
                              dashboards, users, plans, assignments, usage, and 12
                              guided quota scenarios. Reads piped input when stdin
                              is not a terminal.

Options:
  -u, --url <url>          Base URL of the service (default: ${DEFAULT_BASE_URL}, env BASE_URL)
  -k, --key <api-key>      API key (otherwise read from --key-file)
      --key-file <path>    API key file (default: ${DEFAULT_KEY_FILE})
  -h, --help               Show this help

Exit codes: 0 success, 1 failure
`;

export type Command = 'demo' | 'consume' | 'usage' | 'history' | 'simulate';

export interface Options {
  command: Command;
  baseUrl: string;
  key?: string;
  keyFile: string;
  units?: string;
  userId?: string;
  requestId?: string;
  page?: number;
  limit?: number;
}

export function parseOptions(): Options {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: 'string', short: 'u', default: process.env.BASE_URL ?? DEFAULT_BASE_URL },
      key: { type: 'string', short: 'k' },
      keyFile: { type: 'string', default: DEFAULT_KEY_FILE },
      units: { type: 'string', short: 'n' },
      userId: { type: 'string' },
      requestId: { type: 'string', short: 'i' },
      // Deprecated alias for requestId.
      idempotencyKey: { type: 'string' },
      page: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  let key = values.key;
  if (!key) {
    try {
      key = fs.readFileSync(values.keyFile, 'utf8').trim();
    } catch {
      // Reported by requireKey with a clear message.
    }
  }

  // Legacy shape: flags without a subcommand mean a single consume request.
  let command = positionals[0] as Command | undefined;
  if (
    command === undefined &&
    (values.units !== undefined || values.requestId !== undefined || values.idempotencyKey !== undefined)
  ) {
    command = 'consume';
  }
  if (command === undefined) {
    command = 'demo';
  }
  if (!['demo', 'consume', 'usage', 'history', 'simulate'].includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  const parsePositiveInt = (raw: string | undefined, label: string): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`${label} must be a positive integer, got: ${raw}`);
      process.exit(1);
    }
    return n;
  };

  return {
    command,
    baseUrl: values.url,
    key,
    keyFile: values.keyFile,
    units: values.units,
    userId: values.userId,
    requestId: values.requestId ?? values.idempotencyKey,
    page: parsePositiveInt(values.page, '--page'),
    limit: parsePositiveInt(values.limit, '--limit'),
  };
}

export function requireKey(opts: Options): string {
  if (!opts.key) {
    console.error(
      `No API key available. Pass -k <key> or place the key in ${opts.keyFile} (written by bootstrap).`
    );
    process.exit(1);
  }
  return opts.key;
}
