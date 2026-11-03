// Prints the built default dictionaries (dist) as JSON with sorted keys, then its sha256 on stderr.
// Run before and after a change that must not alter any label: the hashes must match.
//   pnpm --filter @durby/i18n build && node packages/i18n/scripts/dump-labels.mjs > labels.json
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const { dictionaries } = await import(pathToFileURL(dist).href);

const sorted = Object.fromEntries(
  Object.keys(dictionaries)
    .sort()
    .map((locale) => [
      locale,
      Object.fromEntries(
        Object.keys(dictionaries[locale])
          .sort()
          .map((key) => [key, dictionaries[locale][key]]),
      ),
    ]),
);
const text = `${JSON.stringify(sorted, null, 2)}\n`;
process.stdout.write(text);
const counts = Object.entries(sorted).map(([locale, d]) => `${locale} ${Object.keys(d).length}`);
process.stderr.write(
  `sha256 ${createHash('sha256').update(text).digest('hex')} (${counts.join(', ')})\n`,
);
