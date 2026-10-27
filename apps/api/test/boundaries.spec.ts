import { ESLint, type Linter } from 'eslint';
import path from 'node:path';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs config module without type declarations
import { apiBoundaries } from '@durby/config/eslint/boundaries';

const fixtureRoot = path.join(__dirname, 'fixtures/boundaries');

describe('module boundary lint rules', () => {
  const messagesByFile = new Map<string, Linter.LintMessage[]>();

  beforeAll(async () => {
    const eslint = new ESLint({
      cwd: fixtureRoot,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        ...(apiBoundaries as (o: { rootPath: string; tsconfigPath: string }) => Linter.Config[])({
          rootPath: fixtureRoot,
          tsconfigPath: path.join(fixtureRoot, 'tsconfig.json'),
        }),
      ],
    });
    for (const result of await eslint.lintFiles(['src/**/*.ts'])) {
      // Forward slashes on every OS, so Windows paths match the fixture names below.
      const file = path.relative(fixtureRoot, result.filePath).split(path.sep).join('/');
      messagesByFile.set(file, result.messages);
    }
  });

  const ruleIds = (file: string): (string | null)[] => {
    const messages = messagesByFile.get(file);
    if (!messages) throw new Error(`fixture not linted: ${file}`);
    return messages.map((m) => m.ruleId);
  };

  it.each([
    ['(a) module → other module index.ts', 'src/modules/beta/via-index.ts'],
    ['(d) module → platform', 'src/modules/beta/uses-platform.ts'],
    ['(e) module → other module directory', 'src/modules/beta/via-dir.ts'],
    ['(f) module → its own internals', 'src/modules/alpha/service.ts'],
    ['(g) platform → platform', 'src/platform/uses-platform.ts'],
    ['(h) root → platform and module index.ts', 'src/app.module.ts'],
    ['(i) root → root', 'src/main.ts'],
    ['(l) platform → platform/database', 'src/platform/uses-database.ts'],
  ])('allows %s', (_label, file) => {
    expect(ruleIds(file)).toEqual([]);
  });

  it.each([
    ['(b) module → other module internals', 'src/modules/beta/via-internal.ts'],
    ['(c) platform → module', 'src/platform/imports-module.ts'],
    ['(j) root → module internals', 'src/root-imports-internal.ts'],
    ['(k) platform → root files', 'src/platform/imports-root.ts'],
    ['(m) module → platform/database', 'src/modules/beta/uses-database.ts'],
  ])('rejects %s', (_label, file) => {
    expect(ruleIds(file)).toEqual(['boundaries/dependencies']);
  });

  it('classifies every fixture file (no unknown files)', () => {
    const unknown = [...messagesByFile.values()]
      .flat()
      .filter((m) => m.ruleId === 'boundaries/no-unknown-files');
    expect(unknown).toEqual([]);
  });
});
