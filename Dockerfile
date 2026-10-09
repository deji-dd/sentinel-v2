# Multi-stage optimized Bun Dockerfile for Sentinel v2 Monorepo
# Bun is pinned rather than `latest`: the runtime version determines GC, Intl and
# crypto behaviour that the scheduler's hot paths are tuned against, so an
# upgrade should be a deliberate change. Bump this together with the
# `bun-version` in .github/workflows/deploy.yml.
#
# Sourced from our own GHCR mirror instead of `oven/bun` directly. Docker Hub
# rate-limits anonymous pulls from GitHub's shared runner IPs (100 per 6h), and
# its auth service has returned 504s mid-build; both failed this pipeline. The
# "Build & Push Container Image" job mirrors a missing tag on its way to the
# build, and .github/workflows/mirror-ci-images.yml does it by hand.
FROM ghcr.io/deji-dd/bun-base:1.4.2 AS base
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
COPY web/dashboard/package.json ./web/dashboard/
COPY web/tt-selector/package.json ./web/tt-selector/

RUN bun install --frozen-lockfile || bun install

# Build stage: compile web frontends and userscripts
FROM dependencies AS builder
WORKDIR /app
COPY . .
RUN bun run web:build
RUN bun run scripts:build

# Production runner image
FROM builder AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002

# Expose API port
EXPOSE 3002

# Default entrypoint (overridden in docker-compose per service)
CMD ["bun", "run", "services/api/index.ts"]
