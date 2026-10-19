import { ApiClient, maskKey } from '../apiClient.js';
import type { MenuInput } from './menu.js';
import type { SimcoWorld } from './setup.js';

/** Everything an action or scenario needs; built once in commands/simulate.ts. */
export interface SimContext {
  api: ApiClient;
  menu: MenuInput;
  companyName: string;
  baseUrl: string;
  /** Masked credential for display — the raw key never reaches this object. */
  maskedKey: string;
  /** Public key prefix (not secret) — used to build a deliberately wrong key. */
  keyPrefix: string;
  world: SimcoWorld;
  /** Unique per run so scenario requestIds never replay across sessions. */
  nextRequestId: (tag: string) => string;
}

export function createNextRequestId(runId: string): (tag: string) => string {
  let seq = 0;
  return (tag: string) => `${tag}-${runId}-${++seq}`;
}

export function buildContext(args: {
  api: ApiClient;
  menu: MenuInput;
  key: string;
  baseUrl: string;
  world: SimcoWorld;
  runId: string;
}): SimContext {
  return {
    api: args.api,
    menu: args.menu,
    companyName: process.env.SIMULATE_COMPANY_NAME ?? process.env.BOOTSTRAP_ACCOUNT_NAME ?? 'SimCo',
    baseUrl: args.baseUrl,
    maskedKey: maskKey(args.key),
    keyPrefix: args.key.split('.')[0] ?? args.key,
    world: args.world,
    nextRequestId: createNextRequestId(args.runId),
  };
}
