// One-shot (ADR 0022): moves every key of src/{en,de}.json into src/<locale>/<prefix>.json, keeping
// each key's value and its order within its prefix, writes src/<locale>/index.ts and deletes the
// two old files. Refuses unless both locales have the same keys in the same order.
//   node packages/i18n/scripts/split-labels.mjs
import { existsSync, rmSync } from 'node:fs';
import {
  LOCALES,
  legacyPath,
  prefixOf,
  readJson,
  readModules,
  writeModules,
} from './label-files.mjs';
import process from 'node:process';

const legacy = Object.fromEntries(LOCALES.map((l) => [l, readJson(legacyPath(l))]));
const order = (l) => Object.keys(legacy[l]).join('\n');
for (const l of LOCALES) {
  if (order(l) !== order('en'))
    throw new Error(`${l}.json: keys differ from en.json or their order`);
  if (readModules(l).size > 0) throw new Error(`src/${l}/ already has label files`);
}

for (const l of LOCALES) {
  const modules = new Map();
  for (const [key, value] of Object.entries(legacy[l])) {
    const prefix = prefixOf(key);
    modules.set(prefix, [...(modules.get(prefix) ?? []), [key, value]]);
  }
  writeModules(l, modules);

  // Read back: the same keys and values, each prefix in its old order.
  const written = readModules(l);
  const merged = Object.fromEntries([...written.values()].flat());
  const same =
    Object.keys(merged).length === Object.keys(legacy[l]).length &&
    Object.entries(legacy[l]).every(([k, v]) => merged[k] === v);
  const ordered = [...written].every(
    ([prefix, entries]) =>
      entries.map(([k]) => k).join('\n') ===
      Object.keys(legacy[l])
        .filter((k) => prefixOf(k) === prefix)
        .join('\n'),
  );
  if (!same || !ordered) throw new Error(`${l}: the split files don't match ${l}.json`);
  process.stdout.write(
    `${l}: ${Object.keys(merged).length} keys in ${written.size} files (${[...written]
      .map(([p, e]) => `${p} ${e.length}`)
      .join(', ')})\n`,
  );
}

for (const l of LOCALES) if (existsSync(legacyPath(l))) rmSync(legacyPath(l));
