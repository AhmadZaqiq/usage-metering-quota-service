# Contributing Guide

This project is a portfolio/learning project. External contributions are not expected, but this guide documents the development workflow for reference.

## Development Setup

### Prerequisites
- Node.js 20+
- Docker and Docker Compose
- Git

### Initial Setup
```bash
# Clone and enter
git clone https://github.com/AhmadZaqiq/usage-metering-quota-service.git
cd usage-metering-quota-service

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Start PostgreSQL
docker compose up -d postgres

# Wait for health check, then run migrations
npm run db:migrate

# Create initial account + API key
npm run bootstrap

# Start development server
npm run dev
```

## Verification Commands

Run these before committing:

```bash
# Type checking (strict)
npm run typecheck

# Linting
npm run lint

# Format (Prettier writes in place; there is no separate check-only script)
npm run format

# Run tests (requires test database)
docker compose up -d postgres-test
npm test

# Build production bundle
npm run build

# All of the above in one command (what CI runs, minus the compose smoke job)
npm run verify
```

CI (`.github/workflows/ci.yml`) runs the same steps on every push to `main`
and every pull request: typecheck, lint, build, and the full test suite
against a PostgreSQL 16 service container, plus a Docker Compose smoke job
that boots the stack, runs the demo client, and executes the invariant
verifier.

## Project Standards

### Code Style
- TypeScript strict mode (with minor relaxations for Drizzle compatibility)
- ESLint + Prettier configured
- No `var` (use `const`/`let`)
- Prefer explicit types; avoid `any`
- Meaningful names over abbreviations

### Architecture Principles
- **Thin Controllers**: Routes only handle HTTP, delegate to services
- **Pure Domain Logic**: Quota evaluator has zero external dependencies
- **Repository Pattern**: Counter operations encapsulated with locking logic
- **Dependency Direction**: Routes → Services → Domain → Repositories → DB
- **No Circular Dependencies**: Enforced by module structure

### Database
- Migrations via Drizzle Kit + custom SQL for constraints/triggers
- Partial unique indexes for current assignments
- Exclusion constraints for overlapping periods
- Triggers for plan-type compatibility
- `NULL` `user_id` for account-level counters (partial unique indexes separate NULL vs non-NULL rows)

### Testing
- Unit tests for pure functions (quota evaluator, hash, date utils)
- Integration tests with real PostgreSQL (test database)
- No mocks for database behavior
- Concurrency tests for critical paths

## Git Workflow

### Commit Messages
Follow conventional commits:
```
feat: add user plan assignment endpoint
fix: handle concurrent counter creation race
docs: update README with example client usage
refactor: extract quota evaluator to pure module
test: add concurrent quota exhaustion test
```

### Branch Strategy
- `main` — stable, deployable
- Feature branches for new work
- No force-push to `main`

## Known Constraints

- **Rate Limiter**: Redis-backed when `REDIS_URL` is set, with a bounded in-process fallback; per-instance counters without Redis
- **Drizzle Partial Indexes**: Custom SQL migrations required for some constraints
- **BigInt Serialization**: JSON responses stringify BigInt values
- **Idempotency Keys**: Never expire (indefinite retention)

## Adding Features

1. Define Zod schema in `src/validation/schemas.ts`
- Add route in appropriate `src/presentation/routes/*.ts`
- Implement service logic in `src/application/*/`
- Add database constraints if needed (custom SQL migration)
- Add unit + integration tests
- Update README if API changes

## Troubleshooting

### Database Connection Issues
```bash
# Check PostgreSQL is running
docker compose ps

# Check logs
docker compose logs postgres

# Recreate database
docker compose down -v && docker compose up -d postgres
```

### TypeScript Errors
```bash
# Clean rebuild
rm -rf dist node_modules
npm install
npm run build
```

### Migration Failures
- Check `src/db/sql/0001_custom_constraints.sql` for constraint conflicts
- Ensure `btree_gist` extension exists
- Verify constraint names match

## Questions?

Refer to `AGENTS.md` for project context and architectural decisions, or open an issue for discussion.