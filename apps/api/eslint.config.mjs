import { base } from '@durby/config/eslint';
import { apiBoundaries } from '@durby/config/eslint/boundaries';

export default [
  { ignores: ['test/fixtures/**'] },
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...apiBoundaries({
    rootPath: import.meta.dirname,
    tsconfigPath: `${import.meta.dirname}/tsconfig.json`,
  }),
];
