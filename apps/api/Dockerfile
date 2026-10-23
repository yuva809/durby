# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/api/Dockerfile --target runtime .
# Targets:
#   runtime  the API server (small, no Prisma CLI), image ghcr.io/<owner>/durby-api;
#            also the outbox worker with `node dist/worker.js` (ADR 0013)
#   migrate  one-off release step: `prisma migrate deploy` as durby_migrator, image durby-api-migrate

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true TURBO_TELEMETRY_DISABLED=1
# pnpm version comes from "packageManager" in package.json.
RUN corepack enable
WORKDIR /repo

# Only the workspaces @durby/api depends on, with a matching lockfile subset.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.9 prune @durby/api --docker

FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter=@durby/api
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @durby/api deploy --prod /out/runtime \
 && pnpm --filter @durby/api deploy /out/migrate
# Postgres is the only datasource: drop the other databases' Prisma query compilers and
# dependency source maps from the runtime (~55 MB). Our own dist/*.map stay for stack traces.
RUN find /out/runtime/node_modules/.pnpm \( -name '*.map' \
      -o -name 'query_compiler_*_bg.sqlite.*' -o -name 'query_compiler_*_bg.mysql.*' \
      -o -name 'query_compiler_*_bg.sqlserver.*' -o -name 'query_compiler_*_bg.cockroachdb.*' \) -delete

FROM ${NODE_IMAGE} AS migrate
# Prisma's schema engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl tini
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/migrate/package.json /out/migrate/prisma.config.ts ./
COPY --from=build /out/migrate/prisma ./prisma
# prisma.config.ts validates MIGRATION_DATABASE_URL with the app's env schema.
COPY --from=build /out/migrate/src/platform/config ./src/platform/config
COPY --from=build /out/migrate/node_modules ./node_modules
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini
ARG APP_VERSION=0.0.0-dev
ENV NODE_ENV=production PORT=4000 APP_VERSION=${APP_VERSION}
# The outbox worker (ADR 0013 §9) runs from this image with `node dist/worker.js`. bin/deploy.sh
# starts the worker service only for images with this label, so rollbacks to older releases work.
LABEL org.durby.worker="dist/worker.js"
WORKDIR /app
# Root-owned and read-only for the node user.
COPY --from=build /out/runtime/package.json ./
COPY --from=build /out/runtime/node_modules ./node_modules
COPY --from=build /out/runtime/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
