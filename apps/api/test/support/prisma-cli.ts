import { join } from 'node:path';

/**
 * The Prisma CLI's JS entry point, run with `process.execPath`. `node_modules/.bin/prisma` is a
 * shell script, which execFileSync can't start on Windows; the entry point works everywhere.
 */
export function prismaCli(apiRoot: string): string {
  return join(apiRoot, 'node_modules', 'prisma', 'build', 'index.js');
}
