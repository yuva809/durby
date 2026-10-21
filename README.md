# Durby

Multi-tenant, white-label, modular restaurant platform. Read `CLAUDE.md` and
`docs/architecture/ARCHITECTURE.md` first.

## Layout

- `apps/api`: NestJS API (`/api/v1`, port 4000)
- `apps/web`: Next.js admin (port 3000)
- `packages/shared`: shared types, Zod schemas, feature/permission keys
- `packages/i18n`: default label dictionaries (`en`, `de`)
- `packages/config`: shared tsconfig, ESLint (incl. module boundaries), Prettier

## Quickstart

Requires Node 22 and pnpm via corepack (`corepack enable`, or `npm i -g corepack`).

```bash
pnpm install
pnpm dev        # api on :4000, web on :3000
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Decisions are recorded in `docs/adr/`.
