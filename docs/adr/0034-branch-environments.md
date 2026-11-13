# ADR 0034: Branch environments and building on the server

- Status: accepted (2026-11-12)
- Date: 2026-11-12
- Step: hosting. Amends [ADR 0004](0004-staging-deployment.md) decision 1 ("the server never builds images") and replaces the
  CI workflow of [ADR 0003](0003-continuous-integration.md).

## Context

There was one hosted environment: staging, deployed from `main` by GitHub Actions. The images were built in Actions,
pushed to GHCR and pulled by the server. Two things changed:

- the team works on a `development` branch that needs its own hosted environment, separate from production;
- GitHub Actions minutes are no longer available, so a deploy must not depend on Actions or on a registry push.

## Decisions

1. **One environment per long-lived branch, both on the same server.** Branches map to environments like this:

   | Branch        | Environment | Directory, compose project    | Domain               |
   | ------------- | ----------- | ----------------------------- | -------------------- |
   | `main`        | production  | `/opt/durby`, `durby-staging` | `staging.durby.tech` |
   | `development` | dev         | `/opt/durby-dev`, `durby-dev` | `dev.durby.tech`     |

   `staging.durby.tech` keeps its name and data and now serves production. Both stacks run from the same
   `infra/staging/` files and differ only in their `.env`, never in code. Each has its own Postgres, Redis, volumes,
   secrets, Mailpit and backups, so a dev deploy can't touch production data.

   - **One edge.** Only one Caddy can own ports 80/443, so production's Caddy serves both stacks. The dev stack sets
     `EDGE=false`: `bin/dc` leaves out the `edge` profile, so it has no Caddy. Its site is
     `/opt/durby/caddy/extra/dev.caddy`, written by `bin/add-stack.sh` and imported by the Caddyfile
     (`import extra/*.caddy`); deploys never remove it.
   - **Shared network.** Caddy reaches each stack's api and web over the external network `durby-shared-edge`, by
     unique aliases (`prod-api`, `dev-web`, …, from `SHARED_ALIAS`). The plain service names `api`/`web` exist on
     that network for both stacks, so nothing dials them there: Caddy and web's `API_URL` use the aliases. Postgres,
     Redis and Mailpit stay on each stack's internal networks.
   - **No shared names.** The dev `.env` sets its own project name (`COMPOSE_PROJECT_NAME=durby-dev`), Mailpit UI port
     (8026), image prefix (`local/durby-dev`, so neither stack's image cleanup deletes the other's releases), Storage
     Box folder (`durby-development`) and backup timer (`durby-backup-dev`, 03:30).
   - **Memory.** Postgres limits are `.env` overrides; the dev stack uses half of production's. Two stacks plus a
     build on the server need about 8 GB, so the server should be resized to that (Hetzner CPX32).

2. **Code reaches production through `development`.** Feature branches merge into `development` (the dev stack).
   A production release is a merge of `development` into `main`. The expand/contract migration rule (ADR 0004)
   still applies: production can be a few releases behind dev.

3. **`bin/release.sh` builds on the server.** It reads `DEPLOY_BRANCH` from `.env` and refuses another branch unless
   given `--force-branch`. It then:

   1. fetches the branch into `/opt/durby/src` and detaches it at the head;
   2. builds the three images with `docker build`, using the targets and `APP_VERSION` of the deploy workflow,
      tagged `<IMAGE_PREFIX>-<image>:<sha>`;
   3. copies the commit's `infra/staging` files into `/opt/durby`;
   4. runs `bin/deploy.sh <sha>`.

   `deploy.sh` is unchanged. It pulls only images that are missing, so locally built images are used as they are,
   and migrations, health checks, automatic rollback and image retention work as before.

4. **No CI pipeline; deploy on every push.** `ci.yml` (ADR 0003) and `deploy-staging.yml` are removed. The one
   workflow, `.github/workflows/deploy.yml`, runs on every push to `main` or `development` (and by hand). It SSHes to
   the server as `deploy` with the existing `STAGING_SSH_*` secrets, uploads `infra/staging/bin` into the branch's
   stack (`/opt/durby` or `/opt/durby-dev`), runs `bin/release.sh` there and checks `/api/v1/health`. Without
   Actions, the same `bin/release.sh` is run by hand.

## Consequences

- A deploy takes several minutes of CPU on the server it deploys to. The Next.js build is the heaviest part, and
  the 2 GB swap from `server-setup.sh` covers its peak. The running release keeps serving during the build.
- Nothing runs lint, typecheck, tests or the format check automatically any more. Run `pnpm lint && pnpm typecheck && pnpm test` before
  merging into `development` or `main`.
- There is no registry copy of a release. Rollback uses the last 5 releases' images kept on the host
  (`deploy.sh --skip-migrations <sha>`). An older release must be checked out in `/opt/durby/src` and built by hand
  (docs/ops/deploy.md → Rollback).
