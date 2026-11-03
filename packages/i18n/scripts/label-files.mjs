// Reading and writing the per-module label files (ADR 0022), for split-labels.mjs and
// absorb-labels.mjs. Both are temporary: removed once every branch has moved to the split layout.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
export const LOCALES = ['en', 'de'];

/** The file a key belongs in: its first segment. */
export const prefixOf = (key) => key.split('.')[0];

export const legacyPath = (locale) => join(SRC, `${locale}.json`);
const dirOf = (locale) => join(SRC, locale);
export const modulePath = (locale, prefix) => join(dirOf(locale), `${prefix}.json`);

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

/** The module files of a locale, by prefix, each an ordered [key, value] list. */
export function readModules(locale) {
  const modules = new Map();
  if (!existsSync(dirOf(locale))) return modules;
  for (const file of readdirSync(dirOf(locale))
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    modules.set(file.slice(0, -5), Object.entries(readJson(join(dirOf(locale), file))));
  }
  return modules;
}

/** Writes every module file and the locale's index.ts (from the files present). */
export function writeModules(locale, modules) {
  mkdirSync(dirOf(locale), { recursive: true });
  for (const [prefix, entries] of modules) {
    writeFileSync(
      modulePath(locale, prefix),
      `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`,
    );
  }
  writeIndex(locale);
}

function writeIndex(locale) {
  const prefixes = readdirSync(dirOf(locale))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
  const lines = [
    `// Default ${locale} labels, one file per key prefix (docs/platform/labels.md, ADR 0022).`,
    ...prefixes.map((p) => `import ${p} from './${p}.json';`),
    '',
    '/** Every label file of this locale, by key prefix (checked in index.test.ts). */',
    'export const labelFiles = {',
    ...prefixes.map((p) => `  ${p},`),
    '};',
    '',
    '/** The whole dictionary: the files never share a key (index.test.ts). */',
    'export default {',
    ...prefixes.map((p) => `  ...${p},`),
    '};',
    '',
  ];
  writeFileSync(join(dirOf(locale), 'index.ts'), lines.join('\n'));
}
