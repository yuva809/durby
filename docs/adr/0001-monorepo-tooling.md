# ADR 0001: Monorepo tooling and baseline conventions

- Status: accepted
- Date: 2026-10-21
- Step: Phase 0.1 (monorepo scaffold)

## Context

Durby is a modular monolith (NestJS API + Next.js admin) with shared types and label dictionaries.
We need one repo layout, one toolchain, and machine-enforced module boundaries before any business code exists.

## Decisions

1. **pnpm workspaces + Turborepo.** `apps/*` and `packages/*`. pnpm is pinned via `packageManager` (`pnpm@12.14.0`, use corepack).
   Build scripts are opt-in through `allowBuilds` in `pnpm-workspace.yaml` (currently `@swc/core`, `esbuild`, `unrs-resolver`).
   We keep pnpm's default minimum release age and pin versions that are too new rather than excluding them.
2. **TypeScript pinned to `~6.0`.** TypeScript 7 is out, but typescript-eslint 8.x supports `<6.1.0`. Revisit when typescript-eslint supports 7.
3. **Shared packages are built** (`@durby/shared`, `@durby/i18n`) with tsup into ESM + CJS + `.d.ts`.
   The Nest API runs CommonJS on Node and can't consume TS sources directly. `dev` runs `tsup --watch` so `turbo dev` picks up changes.
4. **ESLint 10 flat config** in `@durby/config` (`base()`, `next`, `apiBoundaries()`), type-aware via `projectService`.
   Each workspace lints itself. Prettier config is shared from the same package.
5. **Module boundaries** are enforced with `eslint-plugin-boundaries` v7 (`boundaries/dependencies`, default disallow) and
   `eslint-import-resolver-typescript`:
   - `src/platform` may import only `src/platform`.
   - `src/modules/<name>` may import platform, its own files, and other modules only through their `index.ts`.
   - Root files (`src/*.ts`) are a _file category_, not an element. An element at `src` would become the closest element
     for everything below it and silently allow `platform → modules`.
   - `boundaries/root-path` is set explicitly; the plugin otherwise matches patterns relative to `process.cwd()`.
   - `apps/api/test/boundaries.spec.ts` lints fixtures to prove each allowed/denied case.
6. **API**: global prefix `api/v1`, default port 4000. Health lives in `platform/health`, marked `@Public()`.
   Tests use Vitest with `unplugin-swc` so Nest decorator metadata is emitted.
7. **Web**: Next.js App Router, port 3000. The home page fetches API health **server-side** (`API_URL`), validated with the
   shared Zod schema. All visible strings use `t()` from `@durby/i18n` (flat dotted keys).

## Deferred / caveats

- **`exactOptionalPropertyTypes`** is not enabled in the base tsconfig. Revisit once real DTOs and Prisma types exist.
- **`next.config.ts` rewrites read `API_URL` at build time**, so the API target is baked into the build output.
  Revisit in step 0.4 (staging deploy), e.g. runtime proxying or a per-environment build.
  Resolved in [ADR 0004](0004-staging-deployment.md): in staging Caddy routes `/api/*` to the API, so the rewrite
  only serves local development.
- `@Public()` is metadata only until the global auth guard lands (step 1.2).

## Consequences

New top-level folders under `apps/api/src` fail lint (`boundaries/no-unknown-files`) until they are classified.
Packages must be built before dependents typecheck; turbo handles this via `dependsOn: ["^build"]`.
