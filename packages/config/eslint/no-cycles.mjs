import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';

/**
 * No import cycles in apps/api/src (docs/reviews/phase-1.md → R2). A cycle through an index.ts
 * leaves one side with a partly loaded module at startup (undefined exports, decorators applied to
 * undefined); the boundaries rules can't see it. Type-only imports don't run, so they are exempt.
 * @param {{ tsconfigPath: string }} options
 */
export function apiNoCycles({ tsconfigPath }) {
  return [
    {
      files: ['src/**/*.ts'],
      plugins: { 'import-x': importX },
      settings: {
        // Without these, import-x can't parse .ts dependencies and silently finds no cycle.
        'import-x/parsers': { '@typescript-eslint/parser': ['.ts'] },
        'import-x/extensions': ['.ts'],
        'import-x/resolver-next': [
          createTypeScriptImportResolver({ project: tsconfigPath, alwaysTryTypes: true }),
        ],
      },
      rules: {
        'import-x/no-cycle': ['error', { ignoreExternal: true }],
      },
    },
  ];
}

export default apiNoCycles;
