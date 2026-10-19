import { DemoError } from './apiClient.js';

export class ScenarioReport {
  private readonly results: { name: string; ok: boolean; detail: string }[] = [];

  check(name: string, ok: boolean, detail = ''): void {
    this.results.push({ name, ok, detail });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  }

  /** Setup step: failure aborts the demo (later assertions would be noise). */
  expect(name: string, cond: boolean, detail = ''): asserts cond {
    this.check(name, cond, detail);
    if (!cond) {
      throw new DemoError(`Setup failed: ${name}${detail ? ` (${detail})` : ''}`);
    }
  }

  get failureCount(): number {
    return this.results.filter((r) => !r.ok).length;
  }

  summary(): void {
    const failed = this.failureCount;
    const total = this.results.length;
    console.log(`\nScenario summary: ${total - failed}/${total} checks passed`);
    if (failed > 0) {
      for (const r of this.results.filter((x) => !x.ok)) {
        console.log(`  FAILED: ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
      }
    }
  }
}
