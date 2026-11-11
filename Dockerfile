# Rahbin Reply (OpenReply v2) — one image for every Railway service.
#
# The role is picked at runtime by scripts/railway-start.sh:
#   SERVICE_ROLE=web    (default) → prisma migrate deploy + next start on $PORT
#   SERVICE_ROLE=worker           → tsx worker/dm-worker.ts (+ optional cron loop)
#
# The worker runs raw TypeScript through tsx, so the final stage keeps the full
# source tree, tsconfig.json (for the `@/*` alias) and node_modules.

FROM node:20-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Build never talks to the database, but prisma.config.ts reads DATABASE_URL.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# wget: scripts/cron.sh. openssl: Prisma.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app ./

EXPOSE 3000
CMD ["sh", "scripts/railway-start.sh"]
