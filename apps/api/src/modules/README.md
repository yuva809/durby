# Business modules

Each module lives in `src/modules/<name>/` and exposes its public service API through
`src/modules/<name>/index.ts`. Other modules (and `app.module.ts`) may import **only** that
`index.ts`; everything else in the folder is private. `src/platform/` must never import from here.

These rules are enforced by `eslint-plugin-boundaries` (see `packages/config/eslint/boundaries.mjs`)
and covered by `test/boundaries.spec.ts`.
