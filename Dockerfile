# Multi-stage optimized Bun Dockerfile for Sentinel v2 Monorepo
FROM oven/bun:latest AS base
WORKDIR /app

# Install build dependencies & curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy root workspace configs and all package.json files for caching
FROM base AS dependencies
WORKDIR /app
COPY package.json bun.lock* tsconfig.json biome.json ./
COPY packages/database/package.json ./packages/database/
COPY packages/schemas/package.json ./packages/schemas/
COPY packages/torn-api/package.json ./packages/torn-api/
COPY packages/utils/package.json ./packages/utils/
COPY services/api/package.json ./services/api/
COPY services/bot/package.json ./services/bot/
COPY services/scheduler/package.json ./services/scheduler/
COPY web/bot-dashboard/package.json ./web/bot-dashboard/
COPY web/tt-selector/package.json ./web/tt-selector/
COPY web/user-dashboard/package.json ./web/user-dashboard/

RUN bun install --frozen-lockfile || bun install

# Build stage: compile web frontends
FROM dependencies AS builder
WORKDIR /app
COPY . .
RUN bun run web:build

# Production runner image
FROM builder AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002

# Expose API port
EXPOSE 3002

# Default entrypoint (overridden in docker-compose per service)
CMD ["bun", "run", "services/api/index.ts"]
