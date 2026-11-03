# ADR 0022: Default label dictionaries split into one file per key prefix

- Status: accepted (2026-11-03)
- Date: 2026-11-03
- Amends: [ADR 0011](0011-labels.md) (where the defaults live; nothing about resolution or overrides).
  Spec: [labels](../platform/labels.md) → Dictionaries

## Context

All default labels lived in two flat files, `packages/i18n/src/en.json` and `de.json` (1137 keys each, interleaved
across modules). Every feature branch that adds a label edits the same two files, so parallel work (reservations, the
admin portal) conflicts there on nearly every merge, and resolving it by hand risks dropping or misplacing keys in one
locale.

## Decisions

1. **One file per key prefix and locale:** `packages/i18n/src/<locale>/<prefix>.json`, where the prefix is the key's
   first segment (`reservations.nav.title` → `reservations.json`). No exceptions: keys of platform registries stay
   under `platform.*` even when a module owns the entry (`platform.settings.reservations*`,
   `platform.features.pos.*`, `platform.numbering.series.posOrder.*`), so they live in `platform.json`. No key is
   renamed: organization and partner overrides store keys by name.
2. **Merged when the module loads, same runtime shape.** `src/<locale>/index.ts` imports its files and exports the
   spread of all of them (and `labelFiles` for the tests). `dictionaries`, `LabelKey`, `t()` and every caller are
   unchanged. No generated file: a build-time merge would need a committed or prebuilt dictionary, which brings the
   shared file back.
3. **Order:** within a file, keys keep their order; the merged object is grouped by file (alphabetical). Order is
   observable only in the key order of the `GET /api/v1/labels` body, which nothing depends on.
4. **Checks** (`packages/i18n/src/index.test.ts`): every key is in the file of its first segment; each locale imports
   exactly the files in its directory; no key is in two files; every locale has en's files with the same keys in the
   same order. The existing checks (key shape, en keys = locale keys, placeholders) stay.
5. **Migration:** `scripts/split-labels.mjs` moved every key once, with no value changes, proven by
   `scripts/dump-labels.mjs` (built dictionaries, keys sorted, sha256) being identical before and after. Branches
   made before the split run `pnpm --filter @durby/i18n labels:absorb` during their merge or rebase (a three-way
   merge of the old files into the module files, read from git, not from the working tree). Both scripts are removed
   once those branches are in.

## Consequences

- A label change touches only its module's files (and `platform.json` for registry labels), in every locale.
- A new prefix needs a file in every locale and its import in each `index.ts`; the tests fail otherwise.
- git may detect the old `en.json` as renamed to `en/platform.json` and merge a branch's edits into it with conflict
  markers; `labels:absorb` rewrites the module files from git's three versions, so that is harmless.
