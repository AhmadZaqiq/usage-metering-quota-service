import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions, DEFAULT_BASE_URL, type Options } from '../cli/options.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The client resolves its base URL as: -u/--url flag → env BASE_URL →
 * http://localhost:3000. parseOptions reads process.argv and process.env
 * directly, so both are isolated per test. The Docker regression this
 * guards: the container had no BASE_URL, custom commands dropped the -u
 * flag from the compose default command, and the CLI fell back to
 * localhost:3000 where nothing listens inside the container.
 */
const originalArgv = process.argv;
const originalBaseUrl = process.env.BASE_URL;

function parseWith(argv: string[], envBaseUrl: string | undefined): Options {
  process.argv = ['node', 'client', ...argv];
  if (envBaseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = envBaseUrl;
  }
  return parseOptions();
}

afterEach(() => {
  process.argv = originalArgv;
  if (originalBaseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = originalBaseUrl;
  }
});

describe('CLI base URL resolution', () => {
  it('uses env BASE_URL when no -u flag is passed (Docker contract)', () => {
    const opts = parseWith(['simulate'], 'http://app:3000');
    expect(opts.baseUrl).toBe('http://app:3000');
    expect(opts.command).toBe('simulate');
  });

  it('prefers the -u flag over env BASE_URL', () => {
    const opts = parseWith(['-u', 'http://flag.example:9999', 'simulate'], 'http://app:3000');
    expect(opts.baseUrl).toBe('http://flag.example:9999');
  });

  it('falls back to the host default when neither flag nor env is set', () => {
    const opts = parseWith(['simulate'], undefined);
    expect(opts.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe('http://localhost:3000');
  });
});

describe('Docker Compose client service configuration', () => {
  let clientBlock: string;

  beforeAll(() => {
    const compose = readFileSync(join(__dirname, '../../docker-compose.yml'), 'utf8');
    const lines = compose.split('\n');
    const start = lines.findIndex((line) => line === '  client:');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    // Service blocks are 2-space-indented keys; the client block ends at the
    // next one.
    const end = rest.findIndex((line) => /^  \S/.test(line));
    clientBlock = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  });

  it('sets BASE_URL in the client environment so custom commands resolve the app service', () => {
    expect(clientBlock).toMatch(/^ {6}BASE_URL: \$\{BASE_URL:-http:\/\/app:3000\}$/m);
  });

  it('keeps the URL out of the default command (single source of configuration)', () => {
    const commandLine = clientBlock.split('\n').find((line) => line.trim().startsWith('command:'));
    expect(commandLine).toBeDefined();
    expect(commandLine).not.toContain('-u');
    expect(commandLine).not.toContain('http://app:3000');
  });
});
