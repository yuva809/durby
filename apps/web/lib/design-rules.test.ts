import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0015 §5: components are themed only through the semantic tokens, and the product name comes
 * from the theme. app/globals.css is where the default token values live.
 */
const ROOT = join(__dirname, '..');
const SCANNED = ['app', 'components'];
const TOKEN_SOURCE = 'app/globals.css';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir))).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

const PALETTE =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|divide|decoration|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)\b/;

function offenders(pattern: RegExp, skip: string[] = []): string[] {
  return files
    .filter((f) => !skip.includes(f.path))
    .flatMap((f) =>
      f.text
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => pattern.test(line))
        .map(({ i }) => `${f.path}:${i + 1}`),
    );
}

describe('design rules', () => {
  it('scans the web sources', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('uses no hex colors outside the token source', () => {
    expect(offenders(/#[0-9a-fA-F]{3,8}\b(?![\w-])/, [TOKEN_SOURCE])).toEqual([]);
  });

  it('uses no Tailwind palette colors', () => {
    expect(offenders(PALETTE)).toEqual([]);
  });

  it('never hardcodes the product name', () => {
    expect(offenders(/\bDurby\b/)).toEqual([]);
  });
});
