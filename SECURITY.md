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
- **Per-process rate limiting** via a bounded in-process store (no external service; counters reset on restart and are not shared across replicas)
- Unauthenticated: per IP (`ip:<address>`)
- Authenticated: per verified API-key id (`key:<id>`, never the raw secret or prefix)
- Synchronous counter updates within the process, so concurrent requests cannot lose counts; store bounded to 10,000 keys with expired-entry reclamation and oldest-first eviction
- Fail-closed (429): if the store itself fails, the request is rejected — never silently allowed
- Standard headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, plus `Retry-After` on limit rejections

### Secrets Management
- No secrets in source code or Git history
- `.env` file excluded from Git
- `.env.example` contains placeholders only
- API key secrets never logged (only prefix in structured logs)
- Bootstrap credentials via environment variables
- Production: inject secrets via deployment environment/secret manager

### Transport Security
- Development: HTTP (local Docker network)
- Production: Requires reverse proxy with TLS termination (see below)

### TLS Termination Strategy
- **Application does NOT terminate TLS** - designed for reverse proxy termination
- Recommended reverse proxies: nginx, Traefik, Caddy, Cloudflare
- Proxy must forward: `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Request-ID`
- Application trusts proxy headers only when `TRUST_PROXY=true` (default: false)

## Known Limitations

1. **Rate Limiting**: In-process per application instance — counters reset on restart and are not shared across replicas (each replica enforces the configured limit independently); fail-closed (429) if the store fails.
2. **No TLS in Application**: Terminates at reverse proxy (nginx/Traefik/Caddy) in production.
3. **Single Database Instance**: No read replicas or failover configured.
4. **API Key Rotation**: Not automated; manual revocation + creation required.

## Security Checklist for Deployment

- [ ] Use strong, unique `POSTGRES_PASSWORD`
- [ ] Configure reverse proxy with TLS certificates
- [ ] Set `TRUST_PROXY=true` when behind trusted reverse proxy
- [ ] CORS is not configured (no browser clients): if browser-based clients are added later, restrict CORS origins to known domains in `app.ts`
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