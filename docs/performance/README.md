# Performance Evidence

Load-test measurements of the Docker Compose stack on a single WSL2 development machine. Numbers characterize those specific runs; they are **not** universal production capacity guarantees and are not re-run for every change.

## Reports (kept in Git)

| Artifact | What it contains |
|----------|------------------|
| [`2026-10-19-baseline.md`](2026-10-19-baseline.md) | **Current-implementation baseline** (2026-10-19 22:53 UTC, after the Redis removal): environment, method, 30 s / 10-connection results, database evidence, reproduction steps |
| [`2026-10-20-request-path-optimization.md`](2026-10-20-request-path-optimization.md) | Before/after benchmark of the request-path optimization (fused assignment+plan lookups, throttled `last_used_at`): three 30 s runs per side, statement counts, rejected alternatives |
| [`2026-10-20-loadtest-workloads.md`](2026-10-20-loadtest-workloads.md) | Workload-shape analysis of the four load-test modes, hot-path statement inventory, and the correctness rationale for each rejected optimization |
| [`results/extreme-capacity-2026-10-19/REPORT.md`](results/extreme-capacity-2026-10-19/REPORT.md) | Deep capacity campaign run earlier the same day on the Redis-era stack: ladder to 800 connections, 10-minute soak, idempotency storms, quota-boundary races, invariant proofs |
| [`results/extreme-capacity-2026-10-19/scripts/`](results/extreme-capacity-2026-10-19/scripts/) | Reproduction harness for the campaign (stages, multi-runner, sampler, fixtures, probes) |
| [`results/extreme-capacity-2026-10-19/docker-compose.campaign.yml`](results/extreme-capacity-2026-10-19/docker-compose.campaign.yml) | Campaign-only Compose file (project `um-extreme`, ports 3100/5440, no restarts). Frozen at campaign time — it reflects the code layout of 2026-10-19 (including the since-removed Redis service and `dist/scripts/client.js` entrypoint) and is intentionally not updated |

Reproduce the baseline with the commands in [`2026-10-19-baseline.md`](2026-10-19-baseline.md) (§ Reproduction). The campaign flow is documented in `REPORT.md` § 14 and uses the isolated campaign stack — never point `TEST_DATABASE_URL` at the development database.

## Raw artifact archive (moved to a GitHub Release)

Per-request autocannon output, stage logs, warm-up runs, repeated before/after state snapshots, and resource CSV traces (258 files, ~843 KB) were archived out of the default branch for repository browsability. The archived directories were:

- `docs/performance/2026-10-18-stress-raw/` (21 files)
- `docs/performance/results/extreme-capacity-2026-10-19/raw/` (152 files)
- `docs/performance/results/extreme-capacity-2026-10-19/snapshots/` (88 files)

**Download:** [Release `perf-2026-10-19`](https://github.com/AhmadZaqiq/usage-metering-quota-service/releases/tag/perf-2026-10-19) — asset `perf-raw-2026-10-19.tar.gz` (SHA-256 `e415fe4d26fe866eefeec1b680b12678b5df3120a7c89ea859ed496074b5a6a2`).

**Integrity:** verify a downloaded tarball with `sha256sum perf-raw-2026-10-19.tar.gz` and compare against the SHA-256 above.

The tagged commit `perf-2026-10-19` (`66e5063`) also still contains the full tree in Git history; no history was rewritten.

**Credentials:** the campaign key files (`keys.env`, `fixtures-output.json`) were never committed (see `.gitignore`) and are not in the archive; every member was scanned for secrets before upload. The archived `versions-and-config.txt` contains a redacted `DATABASE_URL` only.

## Pruned and historical notes

- The earlier `2026-10-18-compose.md` (30 s baseline) and `2026-10-18-stress.md` (progressive stress) reports were removed in the 2026-10-19 documentation cleanup as superseded: the stress campaign's findings are covered in more depth by the extreme-capacity report, and the 30 s baseline has been re-measured against the current implementation. The stress campaign's raw stage data remains in the release archive (`2026-10-18-stress-raw/`).
- The per-member `ARCHIVE-MANIFEST.sha256` and the campaign `summary.json` (a machine-readable duplicate of the report's results) were removed in the same cleanup; the tarball SHA-256 above remains the integrity check.
- The extreme-capacity campaign and the removed reports still included Redis 7 as the rate-limiter store; Redis has since been removed from the project (rate limiting is now a bounded in-process store). Those measurements were not re-taken.
- `autocannon` does not emit a p95 latency; reports never interpolate one.
