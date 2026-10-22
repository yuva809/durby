import boundaries from 'eslint-plugin-boundaries';

/**
 * Module boundary rules for apps/api (CLAUDE.md hard rules 4 and 5):
 * - platform/ may import platform/ only, never modules/.
 * - a module may import platform/, its own files, and other modules only via their index.ts.
 * - platform/database (raw durby_app client) is private to platform/: modules use platform/tenancy
 *   (ADR 0005), so they cannot skip the tenant-scoped client.
 * - root files (main.ts, app.module.ts, …) wire platform and module entry points together.
 *
 * `rootPath` must be the app root (the folder containing src/): element patterns are matched
 * relative to it, and the plugin otherwise defaults to process.cwd().
 * @param {{ rootPath: string, tsconfigPath: string }} options
 */
export function apiBoundaries({ rootPath, tsconfigPath }) {
  return [
    {
      files: ['src/**/*.ts'],
      plugins: { boundaries },
      settings: {
        'boundaries/root-path': rootPath,
        'import/resolver': {
          typescript: { project: tsconfigPath, alwaysTryTypes: true },
        },
        // First match wins, so the more specific platform/database comes before platform.
        'boundaries/elements': [
          { type: 'platform-database', pattern: 'src/platform/database' },
          { type: 'platform', pattern: 'src/platform' },
          { type: 'module', pattern: 'src/modules/*', capture: ['moduleName'] },
        ],
        // Root files are classified as files, not as an element: an element at `src` would
        // become the closest element for everything under platform/ and modules/.
        // src/cli/*.ts: one-off commands (create-admin, seed-dev), wired like main.ts.
        'boundaries/files': [
          { category: 'app-root', pattern: 'src/*.ts' },
          { category: 'app-root', pattern: 'src/cli/*.ts' },
        ],
      },
      rules: {
        'boundaries/no-unknown-files': 'error',
        'boundaries/dependencies': [
          'error',
          {
            default: 'disallow',
            policies: [
              {
                allow: { to: { module: { origin: ['external', 'core'] } } },
              },
              {
                from: { file: { categories: 'app-root' } },
                allow: [
                  { to: { file: { categories: 'app-root' } } },
                  { to: { element: { type: 'platform' } } },
                  { to: { element: { type: 'module', fileInternalPath: 'index.ts' } } },
                ],
              },
              {
                from: { element: { type: ['platform', 'platform-database'] } },
                allow: { to: { element: { type: ['platform', 'platform-database'] } } },
              },
              {
                from: { element: { type: 'module' } },
                allow: [
                  { to: { element: { type: 'platform' } } },
                  {
                    to: { element: { type: 'module' } },
                    dependency: { relationship: { to: 'internal' } },
                  },
                  { to: { element: { type: 'module', fileInternalPath: 'index.ts' } } },
                ],
              },
            ],
          },
        ],
      },
    },
  ];
}

export default apiBoundaries;
