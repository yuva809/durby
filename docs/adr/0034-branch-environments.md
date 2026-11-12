# ADR 0034: Branch environments and building on the server

- Status: accepted (2026-11-12)
- Date: 2026-11-12
- Step: hosting. Amends [ADR 0004](0004-staging-deployment.md) decision 1 ("the server never builds images").

## Context

There was one hosted environment: staging, deployed from `main` by GitHub Actions. The images were built in Actions,
pushed to GHCR and pulled by the server. Two things changed:

- the team works on a `development` branch that needs its own hosted environment, separate from production;
- GitHub Actions minutes are no longer available, so a deploy must not depend on Actions or on a registry push.

## Decisions

1. **One environment per long-lived branch, each on its own server.** Branches map to environments like this:

   | Branch        | Environment | Server                                                       | Domain               |
   | ------------- | ----------- | ------------------------------------------------------------ | -------------------- |
   | `main`        | production  | the existing server (`/opt/durby`)                           | `staging.durby.tech` |
   | `development` | dev         | a new Hetzner server, set up with the same `server-setup.sh` | `dev.durby.tech`     |

   `staging.durby.tech` keeps its name and data and now serves production. Each server needs its own demo domain
   (`STAGING_DEMO_DOMAIN`) and its own backup folder on the Storage Box (`BACKUP_RCLONE_REMOTE`).

   Both run the same stack from `infra/staging/`. They differ only in `/opt/durby/.env` (domains, secrets, mail,
   `DEPLOY_BRANCH`), never in code. Separate servers keep each stack inside its memory budget, keep ports 80/443
   free for one Caddy each, and stop a dev deploy from touching production data. The compose project name stays
   `durby-staging` on both servers: renaming it would orphan the existing Postgres volume.

2. **Code reaches production through `development`.** Feature branches merge into `development` (the dev server).
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

4. **The Actions workflows stay.** `ci.yml` also runs on pushes to `development`. `deploy-staging.yml` keeps
   deploying `main` to the existing server when Actions is available, which is still correct. The dev server is
   deployed only with `bin/release.sh`.

## Consequences

- A deploy takes several minutes of CPU on the server it deploys to. The Next.js build is the heaviest part, and
  the 2 GB swap from `server-setup.sh` covers its peak. The running release keeps serving during the build.
- Nothing runs lint, typecheck or tests before a server build. Run `pnpm lint && pnpm typecheck && pnpm test` before
  merging into `development` or `main`.
- There is no registry copy of a release. Rollback uses the last 5 releases' images kept on the host
  (`deploy.sh --skip-migrations <sha>`). An older release must be checked out in `/opt/durby/src` and built by hand
  (docs/ops/deploy.md → Rollback).
