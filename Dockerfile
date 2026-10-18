# syntax=docker/dockerfile:1

# --- Build stage: compile TypeScript to dist/ -------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime stage: production dependencies only ----------------------------
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output (including dist/db/sql, copied by the build script) plus the
# Drizzle journal, which is read from source paths and not compiled.
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./src/db/migrations

# Bootstrap writes the one-time API key into the shared secrets volume;
# the directory must be writable by the unprivileged runtime user.
RUN mkdir -p /run/secrets && chown node:node /run/secrets

# Starts as root so the entrypoint can chown the mounted /run/secrets volume,
# then drops to the unprivileged `node` user via busybox `su` so migrations,
# bootstrap, and the app all run as `node`. (node:22-alpine ships busybox `su`;
# it does not ship su-exec, gosu, or a util-linux setpriv with --reuid.)
USER root

COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

# Start as root so the entrypoint can chown the mounted /run/secrets volume,
# then it drops to `node` (busybox `su`) so migrations/bootstrap/app all run as
# the unprivileged `node` user. DATABASE_URL and BOOTSTRAP_* env vars must be
# provided at runtime.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/scripts/bootstrap.js && node dist/main.js"]
