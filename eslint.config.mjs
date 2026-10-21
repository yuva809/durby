import { base } from '@durby/config/eslint';

// Root-level files only; each workspace lints itself with its own eslint.config.mjs.
export default [
  { ignores: ['apps/**', 'packages/**', 'docs/**'] },
  ...base({ tsconfigRootDir: import.meta.dirname }),
];
