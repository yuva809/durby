import { ESLint, type Linter } from 'eslint';
import path from 'node:path';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs config module without type declarations
import { apiNoCycles } from '@durby/config/eslint/no-cycles';

const fixtureRoot = path.join(__dirname, 'fixtures/boundaries');

/** docs/reviews/phase-1.md → R2: the rule catches a runtime cycle, ignores type-only ones. */
describe('import cycle lint rule', () => {
  const rulesByFile = new Map<string, (string | null)[]>();

  beforeAll(async () => {
    const eslint = new ESLint({
      cwd: fixtureRoot,
      overrideConfigFile: true,
      overrideConfig: [
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        ...(apiNoCycles as (o: { tsconfigPath: string }) => Linter.Config[])({
          tsconfigPath: path.join(fixtureRoot, 'tsconfig.json'),
        }),
      ],
    });
    for (const result of await eslint.lintFiles(['src/platform/*cycle-*.ts'])) {
      rulesByFile.set(
        path.relative(fixtureRoot, result.filePath),
        result.messages.map((m) => m.ruleId),
      );
    }
  });

  it('rejects a cycle of value imports', () => {
    expect(rulesByFile.get('src/platform/cycle-a.ts')).toEqual(['import-x/no-cycle']);
    expect(rulesByFile.get('src/platform/cycle-b.ts')).toEqual(['import-x/no-cycle']);
  });

  it('allows a cycle of type-only imports (erased at runtime)', () => {
    expect(rulesByFile.get('src/platform/type-cycle-a.ts')).toEqual([]);
    expect(rulesByFile.get('src/platform/type-cycle-b.ts')).toEqual([]);
  });
});
