# syntax=docker/dockerfile:1

# ── Stage 1: dependencies + build ────────────────────────────────────────────
# This stage keeps devDependencies, so docker-compose reuses it as the `migrate`
# service — the Prisma CLI and tsx both live there. The runtime copies its
# node_modules from `pruned` instead, so they do not ship with the app.
FROM node:22-alpine AS builder

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# `prisma generate` never connects to a database, but Prisma 7 evaluates
# prisma.config.ts first and that file resolves DATABASE_URL eagerly. The
# placeholder is supplied inline so it satisfies the config loader without
# being baked into an image layer — the real URL arrives at runtime.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate     && npm run build

# ── Stage 2: the same tree, without devDependencies ──────────────────────────
# Its own stage, because the prune must NOT happen inside `builder`: compose
# runs the `migrate` service from `builder`, and every tool that service needs
# is a devDependency. `prisma` happens to survive a prune — @prisma/client
# declares it as a peer dependency — but `tsx` does not, so pruning in place
# left `npx tsx prisma/seed.ts` to fetch tsx from the registry mid-deploy.
FROM builder AS pruned

RUN npm prune --omit=dev

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# wget is used by HEALTHCHECK; the base image has no curl.
RUN apk add --no-cache wget

# Run as the image's built-in unprivileged user rather than root.
USER node

COPY --chown=node:node --from=pruned /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json
# Kept for reference and for `prisma migrate status` run against this image.
COPY --chown=node:node --from=builder /app/prisma ./prisma

EXPOSE 3000

# Liveness only. Readiness (which checks the database) is deliberately not used
# here: Docker must not restart a healthy container because Postgres blipped.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/v1/health || exit 1

# `node dist/main.js` directly, not `npm start`: npm would sit between Docker
# and the process and swallow SIGTERM, turning every stop into a 10s kill.
CMD ["node", "dist/main.js"]
