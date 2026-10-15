# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

1. **Do not create a public GitHub issue** for the vulnerability.
2. Email the details to **ahmadawadaa999@gmail.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)
3. Allow reasonable time for assessment and remediation before public disclosure.

## Security Features

### Authentication & Authorization
- API keys use cryptographically secure random secrets (32 bytes, 256-bit entropy)
- Secrets hashed with SHA-256; only prefix (16 hex chars) stored in plaintext
- Full key returned **only once** at creation
- Keys can be revoked; revoked keys rejected immediately
- Account status (active/inactive/deleted) checked on every request

### Tenant Isolation
- All operations scoped to authenticated account via API key
- Client-supplied account IDs never trusted
- Composite foreign keys enforce user→account ownership
- All queries include `account_id` from authenticated context

### Input Validation
- All external input validated via Zod schemas at API boundary
- Request body size limited to 64KB
- Positive integer validation with maximum bounds
- Parameterized queries via Drizzle ORM (no SQL injection)

### Rate Limiting
- In-memory rate limiting (single-instance limitation documented)
- Unauthenticated: per IP
- Authenticated: per API key prefix

### Secrets Management
- No secrets in source code or Git history
- `.env` file excluded from Git
- `.env.example` contains placeholders only
- API key secrets never logged (only prefix in structured logs)
- Bootstrap credentials via environment variables

### Transport Security
- Development: HTTP (local Docker network)
- Production: Requires reverse proxy with TLS termination (not included)

## Known Limitations

1. **In-Memory Rate Limiting**: Not shared across multiple application instances. Use Redis-backed limiter for horizontal scaling.
2. **No TLS in Application**: Terminates at reverse proxy (nginx/Traefik/Caddy) in production.
3. **Single Database Instance**: No read replicas or failover configured.
4. **API Key Rotation**: Not automated; manual revocation + creation required.

## Security Checklist for Deployment

- [ ] Use strong, unique `POSTGRES_PASSWORD`
- [ ] Configure reverse proxy with TLS certificates
- [ ] Restrict CORS origins to known domains
- [ ] Set `LOG_LEVEL=warn` or `error` in production
- [ ] Use secrets manager for `DATABASE_URL` and other secrets
- [ ] Configure database connection pooling for production load
- [ ] Enable database audit logging if required
- [ ] Review and adjust rate limit thresholds
- [ ] Implement API key rotation policy

## Out of Scope

This project does not implement:
- End-user authentication (JWT/OAuth)
- Role-based access control (RBAC)
- Audit logging beyond structured decision logs
- Distributed tracing
- Encryption at rest (relies on PostgreSQL/filesystem)
- Automated vulnerability scanning (add to CI/CD pipeline)

## Contact

For security concerns, contact: **ahmadawadaa999@gmail.com**