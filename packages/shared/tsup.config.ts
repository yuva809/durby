import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  // Keep dist/ in watch mode so dependents (nest --watch) never see missing type declarations.
  clean: !options.watch,
  sourcemap: true,
}));
