import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';

const integrationTests = ['test/**/*.int.spec.ts', 'test/**/*.e2e.spec.ts'];

export default defineConfig({
  // SWC instead of esbuild so Nest decorator metadata is emitted in tests.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, ...integrationTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: integrationTests,
          // One fresh Postgres (roles + migrations) and Redis per run; see test/setup/containers.global.ts.
          globalSetup: ['test/setup/containers.global.ts'],
          setupFiles: ['test/setup/env.ts'],
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
