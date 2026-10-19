import { ApiClient, maskKey } from '../apiClient.js';
import type { Options } from '../options.js';

export async function runConsume(opts: Options, key: string): Promise<number> {
  if (!opts.units || !opts.requestId) {
    console.error('consume command requires both -n <units> and -i <request-id>.');
    console.error('Run with --help for usage.');
    return 1;
  }

  const api = new ApiClient(opts.baseUrl, key);
  const body: Record<string, unknown> = {
    units: opts.units,
    requestId: opts.requestId,
  };
  if (opts.userId) body.userId = opts.userId;

  console.log(`POST ${opts.baseUrl}/usage  (key ${maskKey(key)})`);
  const res = await api.request('POST', '/usage', body);
  console.log(`Status: ${res.status}`);
  console.log(JSON.stringify(res.data, null, 2));
  return res.status >= 200 && res.status < 300 ? 0 : 1;
}
