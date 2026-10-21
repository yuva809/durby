import { base } from '@durby/config/eslint';
import { next } from '@durby/config/eslint/next';

export default [...base({ tsconfigRootDir: import.meta.dirname }), ...next];
