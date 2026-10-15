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

# Format check
npm run format

# Run tests (requires test database)
docker compose up -d postgres-test
npm test

# Build production bundle
npm run build
```

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
- Sentinel `user_id = 0` for account-level counters

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

- **In-Memory Rate Limiter**: Not distributed; single-instance only
- **Drizzle Partial Indexes**: Custom SQL migrations required for some constraints
- **BigInt Serialization**: JSON responses stringify BigInt values
- **Idempotency Keys**: Never expire (indefinite retention)

## Adding Features

1. Define Zod schema in `src/validation/schemas.ts`
- Add route in appropriate `src/routes/*.ts`
- Implement service logic in `src/modules/*/`
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