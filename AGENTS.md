# Project Instructions — Usage Metering & Quota Service

## 1. Developer Profile and Collaboration

The project owner is a recent Computer Systems Engineering graduate from Palestine Polytechnic University, focused on becoming a strong backend engineer.

Primary career direction:
- Backend development.
- REST APIs and backend architecture.
- Database design, transactions, and data integrity.
- Authentication, authorization, security, and reliability.
- Writing maintainable code that can be explained confidently in technical interviews.

The developer has practical learning experience with C#, .NET, ASP.NET Core concepts, SQL Server, ADO.NET, REST APIs, EF Core, dependency injection, SOLID, validation, JWT, authorization policies, and testing concepts. This project uses TypeScript and PostgreSQL, so do not assume that every TypeScript, Node.js, Express, or PostgreSQL-specific detail is already familiar.

### How to work with the developer

- Treat this as a serious engineering project and a learning opportunity, not a code-generation exercise.
- Explain important architectural decisions in clear, practical language.
- When introducing a new or unfamiliar concept, explain what it does, why it is needed, what alternatives exist, and why the selected approach is appropriate here.
- Use Arabic for explanations when directly teaching the developer, unless English is requested. Keep code identifiers, technical terminology, API contracts, and documentation professional and consistent.
- Prefer concise explanations with concrete examples over generic theory or excessively long lectures.
- Connect architectural concepts to actual files, functions, database constraints, and tests in this repository.
- Do not explain every trivial line of code unless asked.
- Never assume the developer understands an implementation simply because the code compiles.
- Do not hide complexity behind unexplained abstractions.
- Help the developer become capable of independently implementing, debugging, testing, and defending the design during interviews.
- When presenting important decisions, explain the trade-offs and the failure mode the decision prevents.
- Be honest about uncertainty, incomplete work, and unverified behavior.

## 2. Project Mission

Build a professional, backend-only Usage Metering & Quota Service.

The service must:
- Authenticate tenants using API keys.
- Isolate data and operations by account.
- Manage system plans and account-owned custom plans.
- Support account-level and user-level monthly allowances.
- Manage plan assignments and assignment history.
- Accept or reject usage requests according to quota rules.
- Prevent duplicate consumption through idempotency.
- Preserve correctness under concurrent requests.
- Use PostgreSQL transactions and database constraints to protect invariants.
- Provide structured logging, consistent errors, health endpoints, rate limiting, and API documentation.
- Include meaningful unit, integration, concurrency, and failure-handling tests.
- Run locally using Docker and a documented setup procedure.
- Include an example client, reproducible load-test scripts, and a complete README.

The goal is a maintainable and demonstrably correct backend, not the maximum possible number of files, abstractions, or features.

## 3. Technology Stack

Use the agreed stack unless a concrete technical limitation justifies a documented change:

- TypeScript with strict compiler settings.
- Node.js.
- Express.
- PostgreSQL 16 or a compatible supported version.
- Drizzle ORM and Drizzle Kit.
- Zod for input and environment validation.
- Pino for structured logging.
- Vitest for testing.
- Supertest for HTTP integration testing.
- Docker Compose for local development.
- OpenAPI 3.1 and Swagger UI for API documentation.

Use native TypeScript `bigint` for PostgreSQL BIGINT quota values and counters.

Do not change frameworks or add major dependencies without a real technical reason. Verify compatibility with the installed versions and official documentation.

## 4. Architecture and Separation of Responsibilities

Use a clear, layered modular architecture.

Recommended dependency direction:

HTTP Routes / Controllers
    -> Application Services / Use Cases
        -> Domain Rules and Interfaces
        -> Repository Contracts
            -> PostgreSQL / Drizzle Implementations

Cross-cutting infrastructure includes configuration, logging, middleware, validation, errors, database connection management, and operational health checks.

The exact directory structure may evolve as the project grows, but responsibility boundaries must remain explicit.

### Routes and controllers

Responsible for:
- HTTP request and response handling.
- Calling the appropriate application service.
- Mapping results to HTTP status codes and response DTOs.
- Passing validated input and authenticated context.

Must not:
- Contain quota evaluation algorithms.
- Contain complicated business workflows.
- Write raw database queries directly.
- Reimplement validation or business rules already owned elsewhere.

### Application services and use cases

Responsible for:
- Orchestrating business operations.
- Enforcing workflow-level business rules.
- Coordinating repositories and other required dependencies.
- Defining transaction boundaries where appropriate.
- Returning clear application-level results.

Must not become giant classes responsible for unrelated features.

Keep authentication, plan management, assignments, usage processing, and health checks in their appropriate modules.

### Domain logic

Keep important business rules independent of HTTP and database implementation whenever practical.

For example:
- `quotaEvaluator` should be a pure function.
- It must not import Express, Drizzle, PostgreSQL clients, or HTTP response objects.
- It should be independently testable with bigint inputs.
- Quota decisions should be deterministic for identical inputs.

Do not create an elaborate domain framework merely to satisfy a pattern. Isolate the business rules that genuinely benefit from independence.

### Repositories and data access

Responsible for:
- Database queries and persistence.
- Mapping database records to application-level representations where necessary.
- Encapsulating complex queries and concurrency primitives.
- Implementing repository contracts when those contracts provide meaningful separation.

Keep raw SQL, Drizzle queries, database-specific behavior, and locking logic out of HTTP handlers and pure business functions.

Do not create a repository interface and implementation for every table automatically. Choose boundaries according to actual responsibilities and testing needs.

### Database infrastructure

The database layer owns:
- Connection pool configuration.
- Drizzle client initialization.
- Transaction infrastructure.
- Migration execution and migration configuration.
- Database lifecycle and shutdown.
- Database health checks.

Do not spread database connection initialization throughout business modules.

### Cross-cutting concerns

Keep these responsibilities independently understandable:
- Configuration and environment validation.
- Authentication middleware.
- Request correlation and structured logging.
- Input validation.
- Error types and error-to-HTTP mapping.
- Rate limiting.
- Health and readiness checks.
- OpenAPI generation or specification maintenance.

Avoid circular dependencies between modules.

## 5. SOLID Principles

Apply SOLID deliberately rather than mechanically.

### Single Responsibility Principle

A module or class should have one coherent reason to change.

Examples:
- `quotaEvaluator` evaluates quota decisions.
- `apiKeyService` manages API-key lifecycle operations.
- `assignmentService` manages assignment rules and lifecycle.
- `counterRepository` handles persistence and concurrency behavior for counters.
- `usageService` coordinates the usage-processing workflow.

Do not combine authentication, quota evaluation, persistence, logging configuration, and HTTP serialization into one service.

### Open/Closed Principle

Keep code easy to extend when there is a realistic extension requirement.

Do not introduce plugin systems, generic rule engines, or complex abstractions for hypothetical future features.

### Liskov Substitution Principle

Implementations of an abstraction must honor the same behavioral contract, error expectations, and invariants.

### Interface Segregation Principle

Prefer small, focused interfaces when abstractions are useful. Avoid large interfaces that force implementations to provide unrelated methods.

### Dependency Inversion Principle

Keep high-level business logic independent of low-level infrastructure where meaningful.

Use dependency injection to make important dependencies explicit and testable. Do not add an interface for every class just to claim DIP compliance.

SOLID is a means of improving correctness, testability, and maintainability. It is not a requirement to maximize the number of abstractions.

## 6. Coding Style and Maintainability

- Use TypeScript strict mode and meaningful type definitions.
- Avoid `any`. If unavoidable, isolate it, explain why, and validate the boundary.
- Avoid unsafe type assertions and non-null assertions unless justified.
- Prefer explicit, meaningful names over cryptic abbreviations.
- Use consistent naming conventions.
- Keep functions focused and reasonably small.
- Avoid duplicated business rules.
- Avoid deep nesting and unnecessarily complicated conditional logic.
- Prefer early returns when they improve readability.
- Avoid magic numbers and unexplained strings.
- Centralize configuration and business limits where appropriate.
- Avoid redundant wrappers, pass-through services, and abstractions without meaningful behavior.
- Do not use inheritance when composition or a simple function is clearer.
- Keep comments focused on intent, invariants, and non-obvious decisions.
- Do not add comments that merely translate the next line of code into English.
- Do not optimize prematurely, but do address measured bottlenecks and obvious scalability risks.
- Follow the formatter and lint rules configured in the repository.
- Keep code style consistent across the project rather than enforcing personal preferences inconsistently.

Prefer readable, explicit code over clever code.

## 7. Dependency Injection and Testing

Use dependency injection where it improves testability, isolation, or control over infrastructure.

- Make important dependencies explicit.
- Avoid hidden global mutable state.
- Keep pure functions free of injected dependencies when they do not need any.
- Use unit tests for business logic.
- Use real PostgreSQL integration tests for constraints, transactions, locking, migrations, and concurrency.
- Use mocks only when they provide value for the specific test.
- Do not mock PostgreSQL behavior in a test intended to prove PostgreSQL correctness.
- Keep tests isolated and repeatable.
- Do not weaken assertions to obtain a green test suite.
- Do not skip failing tests without a documented reason and an explicit unresolved status.

A successful type check is not proof of business correctness. A passing unit test is not proof of transaction correctness. Use the appropriate verification level for each requirement.

## 8. Database Design and Integrity

PostgreSQL is the source of truth for persisted state.

- Use primary keys, foreign keys, unique constraints, CHECK constraints, and indexes appropriately.
- Encode important invariants at the database level when possible.
- Treat application validation as complementary to database constraints, not a replacement for them.
- Use explicit transactions for operations that must succeed or fail atomically.
- Understand the locking and isolation behavior of the selected PostgreSQL strategy.
- Avoid N+1 queries and unnecessary database round trips.
- Add indexes based on actual access patterns and query requirements.
- Document custom SQL migrations and database-specific constraints.
- Ensure a clean database can be migrated from scratch.
- Keep migration history consistent and reproducible.
- Never assume that an ORM API guarantees a particular concurrency property without verifying the generated SQL and database behavior.

### Usage and quota invariants

- Account and user counters must not be overspent by concurrent requests.
- Counter creation must be safe when multiple requests arrive simultaneously.
- Account counters and user counters must be updated atomically when a usage request is accepted.
- Rejected requests must not consume quota.
- Repeated requests with the same idempotency key and identical semantic input must return the original committed result.
- Reusing an idempotency key with different semantic input must produce a consistent conflict response.
- A failed transaction must not leave partial consumption.
- Tenant ownership must be enforced for every relevant read and write.
- UTC monthly periods must be computed consistently for the entire request.
- Assignment effective dates and overlap rules must be enforced correctly, including nullable assignment subjects.

Use native bigint arithmetic for quota calculations. Serialize bigint values as strings in JSON.

## 9. Security and API Contracts

- Never trust a client-supplied account ID as the source of tenant identity.
- Derive tenant context from authenticated credentials.
- Validate external input at application boundaries.
- Use parameterized queries.
- Generate API-key secrets using cryptographically secure randomness.
- Store only the key hash and required lookup prefix, not the complete secret.
- Return a newly generated full API key only through the intended one-time creation response.
- Never log secrets, authorization headers, or sensitive credentials.
- Enforce ownership and authorization on resource operations.
- Handle revoked keys and inactive or deleted accounts consistently.
- Use consistent error response shapes and stable error codes.
- Do not expose internal stack traces or sensitive database details to clients.
- Configure CORS according to actual requirements; do not enable unrestricted origins by default.
- Apply sensible request size limits and rate limiting.
- Document the authentication scheme and all relevant endpoint contracts.
- Do not describe the API as secure without meaningful tests and review.

HTTP status codes must reflect the documented contract. Business rejection and infrastructure failure are different outcomes.

## 10. Testing and Verification Workflow

After each meaningful change:

1. Inspect the diff.
2. Run the most relevant focused tests.
3. Run type checking and linting where applicable.
4. Run integration tests for changed database or HTTP behavior.
5. Investigate failures and fix their root causes.
6. Run the broader suite at milestone boundaries.
7. Record actual results.

Use the package manager and scripts selected by the project. Do not invent commands or assume scripts exist before checking `package.json`.

Test at least:
- Validation boundaries.
- Authentication and tenant isolation.
- Authorization and ownership.
- Quota acceptance and rejection.
- Bigint arithmetic boundaries.
- Idempotency and request hash conflicts.
- Counter initialization.
- Concurrent quota consumption.
- Transaction rollback.
- Database constraints.
- Month-boundary behavior.
- Health checks and operational failures.

Never claim tests passed unless their results confirm that.

## 11. Git and Change Management

- Inspect `git status` before making changes.
- Never overwrite unrelated user changes.
- Keep commits small enough to review and meaningful enough to understand.
- Use descriptive commit messages.
- Commit validated milestones rather than knowingly broken intermediate states.
- Keep secrets, `.env` files, and database dumps out of Git.
- Review the final diff before declaring a milestone complete.
- Do not push, publish, deploy, or expose the repository externally without explicit authorization.
- Maintain an honest implementation status with completed work, verification results, known issues, and next steps.

## 12. Autonomous Work and Decision-Making

The developer prefers proactive execution instead of repeatedly being asked to approve routine implementation details.

- Inspect the repository before making assumptions.
- Continue through the agreed roadmap rather than stopping after producing a plan.
- Make reasonable engineering decisions within the documented scope.
- Record important decisions and their rationale.
- Ask for clarification only when an unresolved decision materially affects correctness, security, scope, or a user-owned choice that cannot safely be inferred.
- Do not ask for permission to run ordinary project checks, fix implementation defects, or continue an agreed phase.
- Never conceal a blocker or falsely claim completion.
- If execution must stop, preserve an accurate and actionable status.
- Do not substitute additional planning or lengthy status messages for implementation.

The deadline is October 18, 2026, with final review and submission preparation intended for October 19–20. Use these dates to prioritize the critical path without sacrificing correctness.

## 13. Documentation and Interview Readiness

Maintain documentation that explains the actual implementation rather than an idealized design.

Document important decisions, especially:
- Layer boundaries and dependency direction.
- Transaction boundaries and lock ordering.
- Idempotency strategy.
- Quota consistency guarantees.
- Database constraints and custom migrations.
- API-key storage and verification.
- Error mapping.
- Testing strategy.
- Known limitations and operational assumptions.

When a major design decision is implemented, be able to explain:
1. What problem it solves.
2. Why the selected approach fits this project.
3. What alternative approaches were considered.
4. What failure mode it prevents.
5. How the implementation and tests demonstrate correctness.

Do not add complexity merely to make the project appear more advanced. Favor defensible engineering decisions over unnecessary sophistication.

## 14. Final Principle

Build this project as a professional backend engineer would: clear responsibilities, deliberate abstractions, strong database integrity, safe transaction behavior, meaningful automated tests, understandable documentation, and honest verification.

The developer values SOLID, clean separation of concerns, explicit design, practical explanations, and maintainable code. Preserve those values without overengineering.

**The objective is not merely to produce code that runs. It is to produce a correct, maintainable service that the developer understands and can confidently explain and defend.**
