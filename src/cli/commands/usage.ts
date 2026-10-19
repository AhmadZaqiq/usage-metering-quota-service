import { historyQuery, printHistory } from './history.js';
import type { Options } from '../options.js';

export async function runUsage(opts: Options, key: string): Promise<number> {
  if (!opts.userId) {
    console.error('usage command requires --userId <clientUserId>.');
    console.error('Run with --help for usage.');
    return 1;
  }
  const params = historyQuery(opts);
  params.set('userId', opts.userId);
  return await printHistory(opts, key, params);
}
