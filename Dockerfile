FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache postgresql-client

COPY package*.json ./

RUN npm ci --include=dev

COPY . .

RUN npm run build

EXPOSE 3000

# Run migrations and bootstrap on startup, then start the app.
# DATABASE_URL and BOOTSTRAP_* env vars must be provided at runtime.
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx src/scripts/bootstrap.ts && node dist/main.js"]