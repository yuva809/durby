import { base } from '@durby/config/eslint';
import { apiBoundaries } from '@durby/config/eslint/boundaries';
import { apiNoCycles } from '@durby/config/eslint/no-cycles';

export default [
  { ignores: ['test/fixtures/**', 'src/platform/database/generated/**'] },
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...apiBoundaries({
    rootPath: import.meta.dirname,
    tsconfigPath: `${import.meta.dirname}/tsconfig.json`,
  }),
  ...apiNoCycles({ tsconfigPath: `${import.meta.dirname}/tsconfig.json` }),
];
