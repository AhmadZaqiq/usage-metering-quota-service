# Contributing Guide

This project is a portfolio/learning project. External contributions are not expected, but this guide documents the development workflow for reference.

## Development Setup

Prerequisites: Node.js 20+, Docker with Docker Compose, Git.

Follow the [README Quick Start](README.md#quick-start) for environment configuration, `docker compose up -d --build`, retrieving the bootstrap API key, and local (non-Docker) development. Project context, architecture rules, and working agreements live in [`AGENTS.md`](AGENTS.md); the implemented design lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Verification Commands

Run these before committing:

```bash
# Type checking (strict), lint, build, full test suite
# (tests need the compose test database: docker compose up -d postgres-test)
npm run verify

# Everything above plus the accounting-invariant verifier
# (DATABASE_URL must point at a migrated database, e.g. the compose dev DB)
DATABASE_URL=postgresql://app:app_secret@localhost:5432/usage_metering npm run verify:all

# Docker-native equivalents
docker compose config --quiet
docker compose --profile tests run --rm tests
docker compose run --rm client   # demo + invariants against the running app
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, build, and the full suite against a PostgreSQL 16 service container on every push to `main` and every pull request, plus a Docker Compose smoke job that boots the stack, runs the demo client, and executes the invariant verifier.

## Project Standards

- TypeScript strict mode; ESLint + Prettier; no `var`; avoid `any`
- Layered architecture: thin routes → application services → pure domain → repositories → database (details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md))
- Real PostgreSQL for integration and concurrency tests; no mocks for database behavior
- Migrations via Drizzle Kit plus custom SQL for constraints/triggers

## Git Workflow

- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`
- `main` is stable and deployable; use feature branches; never force-push `main`

## Known Constraints

See the README "Known Limitations & Deferred Findings" for the full list. The ones that most often affect development:

- **Rate limiter**: bounded in-process store (per-instance counters; reset on restart, not shared across replicas); fail-closed (429) if the store fails
- **BigInt serialization**: JSON responses stringify BigInt values
- **Idempotency keys**: unique per account, retained indefinitely
- **Drizzle partial indexes**: some constraints require custom SQL migrations

## Adding Features

1. Define a Zod schema in `src/validation/schemas.ts`
2. Add a route in `src/presentation/routes/` and wire it in `src/app.ts`
3. Implement service logic in `src/application/`
4. Add database constraints if needed (custom SQL migration)
5. Add unit + integration tests; update `docs/API.md` and the README if the API changes

## Troubleshooting

```bash
docker compose ps                          # container health
docker compose logs postgres app          # recent errors
```

If the local database is corrupt beyond repair and you accept losing all local data, recreate the stack with `docker compose down -v && docker compose up -d postgres`. **`-v` permanently deletes the named volumes (`pgdata`, `pgdata_test`, `bootstrap-secrets`) — including the bootstrap API key and all local usage data. Never use it to make tests pass; tests must pass against a healthy database.**

TypeScript errors after dependency changes: `rm -rf dist node_modules && npm install && npm run build`.

Migration failures: check `src/db/sql/0001_custom_constraints.sql` for constraint conflicts, ensure the `btree_gist` extension exists, and verify constraint names match.

## Questions?

Refer to [`AGENTS.md`](AGENTS.md) for project context and architectural decisions, or open an issue for discussion.
