# Performance Evidence

Dated load-test measurements of the Docker Compose stack on a single WSL2 development machine. Numbers characterize those specific runs; they are **not** universal production capacity guarantees and are not re-run for every change.

## Reports (kept in Git)

| Artifact | What it contains |
|----------|------------------|
| [`2026-10-18-compose.md`](2026-10-18-compose.md) | 30-second baseline (10 connections): method, environment, database evidence, reproduction steps |
| [`2026-10-18-stress.md`](2026-10-18-stress.md) | Progressive stress campaign (10→1000 connections, idempotency storm, multi-user contention, invariant checks) |
| [`results/extreme-capacity-2026-10-19/REPORT.md`](results/extreme-capacity-2026-10-19/REPORT.md) | Isolated extreme-capacity campaign up to 800 connections, 10-minute soak, boundary-race and idempotency proofs |
| [`results/extreme-capacity-2026-10-19/summary.json`](results/extreme-capacity-2026-10-19/summary.json) | Machine-readable distilled results for the extreme-capacity campaign |
| [`results/extreme-capacity-2026-10-19/scripts/`](results/extreme-capacity-2026-10-19/scripts/) | Reproduction harness used for the campaign (stages, multi-runner, sampler, fixtures, probes) |
| [`results/extreme-capacity-2026-10-19/docker-compose.campaign.yml`](results/extreme-capacity-2026-10-19/docker-compose.campaign.yml) | Campaign-only Compose file (project `um-extreme`, ports 3100/5440, no restarts). Frozen at campaign time — it reflects the code layout of 2026-10-19 (including the since-removed Redis service and `dist/scripts/client.js` entrypoint) and is intentionally not updated |

## Raw artifact archive (moved to a GitHub Release)

Per-request autocannon output, stage logs, warm-up runs, repeated before/after state snapshots, and resource CSV traces (258 files, ~843 KB) were archived out of the default branch for repository browsability. The archived directories were:

- `docs/performance/2026-10-18-stress-raw/` (21 files)
- `docs/performance/results/extreme-capacity-2026-10-19/raw/` (152 files)
- `docs/performance/results/extreme-capacity-2026-10-19/snapshots/` (88 files)

**Download:** [Release `perf-2026-10-19`](https://github.com/AhmadZaqiq/usage-metering-quota-service/releases/tag/perf-2026-10-19) — asset `perf-raw-2026-10-19.tar.gz` (SHA-256 `e415fe4d26fe866eefeec1b680b12678b5df3120a7c89ea859ed496074b5a6a2`).

**Integrity:** [`ARCHIVE-MANIFEST.sha256`](ARCHIVE-MANIFEST.sha256) lists the SHA-256 of every archived member at its original repository path. Verify a downloaded tarball with:

```bash
tar -xzf perf-raw-2026-10-19.tar.gz && sha256sum -c ARCHIVE-MANIFEST.sha256 --quiet
```

The tagged commit `perf-2026-10-19` (`66e5063`) also still contains the full tree in Git history; no history was rewritten.

**Credentials:** the campaign key files (`keys.env`, `fixtures-output.json`) were never committed (see `.gitignore`) and are not in the archive; every member was scanned for secrets before upload. The archived `versions-and-config.txt` contains a redacted `DATABASE_URL` only.

## Historical notes

- The 2026-10-18/19 environment still included Redis 7 as the rate-limiter store; Redis has since been removed from the project (rate limiting is now a bounded in-process store). Measurements were not re-taken.
- `autocannon` does not emit a p95 latency; reports never interpolate one.
