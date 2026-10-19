import { ApiClient, maskKey } from '../apiClient.js';
import type { Options } from '../options.js';

export function historyQuery(opts: Options): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.page !== undefined) params.set('page', String(opts.page));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  return params;
}

export async function printHistory(opts: Options, key: string, params: URLSearchParams): Promise<number> {
  const query = params.toString();
  const path = query ? `/usage?${query}` : '/usage';
  const api = new ApiClient(opts.baseUrl, key);
  console.log(`GET ${opts.baseUrl}${path}  (key ${maskKey(key)})`);
  const res = await api.request('GET', path);
  console.log(`Status: ${res.status}`);
  console.log(JSON.stringify(res.data, null, 2));
  return res.status >= 200 && res.status < 300 ? 0 : 1;
}

export async function runHistory(opts: Options, key: string): Promise<number> {
  return await printHistory(opts, key, historyQuery(opts));
}
