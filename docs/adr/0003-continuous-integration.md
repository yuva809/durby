# ADR 0003: Continuous integration

- Status: accepted
- Date: 2026-10-21
- Step: Phase 0.3 (CI)

## Context

CLAUDE.md requires `pnpm lint && pnpm typecheck && pnpm test` to pass before work is called done. That needs to be
enforced on every change, not only run locally, and the integration tests (Testcontainers, ADR 0002) must run too.

## Decisions

1. **GitHub Actions, one job** (`.github/workflows/ci.yml`) on every pull request and every push to `main`:
   install (`--frozen-lockfile`), `format:check`, `lint`, `typecheck`, `test`, `build`. Any failing step fails the run.
   CI runs the same root scripts as developers, so there is no CI-only logic.
2. **Integration tests run in CI via Testcontainers** on `ubuntu-latest`, which has Docker. No `services:` Postgres:
   the test global setup starts its own container with `infra/postgres/init/01-roles.sql` and applies migrations, so
   CI and local runs use identical roles. CI needs no secrets.
3. **Caching**: pnpm store via `actions/setup-node` (`cache: pnpm`), Turborepo local cache (`.turbo`) via
   `actions/cache`. No remote Turbo cache yet.
4. **Toolchain versions** come from the repo: Node from `.nvmrc`, pnpm from `packageManager` in `package.json`.
5. **Concurrency**: one run per ref; superseded PR runs are cancelled, runs on `main` never are.
   Job timeout 20 minutes. Workflow token is read-only (`contents: read`).
6. **PR template** (`.github/pull_request_template.md`) mirrors the CLAUDE.md hard rules as a checklist. When a hard
   rule changes, update the template in the same PR.
