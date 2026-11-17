# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/web/Dockerfile .
# Runs the Next.js standalone server (output: 'standalone' in next.config.ts).

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
# pnpm version comes from "packageManager" in package.json.
RUN corepack enable
WORKDIR /repo

# Only the workspaces @durby/web depends on, with a matching lockfile subset.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.9 prune @durby/web --docker

FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
# Baked into the /api/v1 rewrite at build time (local-dev path; Caddy routes /api/* in staging).
ARG API_URL=http://api:4000
ENV API_URL=${API_URL}
RUN pnpm turbo run build --filter=@durby/web

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini
ARG APP_VERSION=0.0.0-dev
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    API_URL=http://api:4000 APP_VERSION=${APP_VERSION}
WORKDIR /app
# Root-owned and read-only for the node user. Next writes its cache under .next/cache only.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# The push service worker (sw.js, ADR 0047): served from the site root.
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
