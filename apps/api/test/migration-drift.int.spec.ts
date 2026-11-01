import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOwnDatabase } from './support/own-database';
import { prismaCli } from './support/prisma-cli';

const apiRoot = join(__dirname, '..');

/**
 * Migrations and schema.prisma agree (issue #43): a fresh database migrated with every migration
 * diffs empty against the schema. Otherwise the next generated migration would carry drops of
 * objects the schema doesn't declare (hand-written indexes and foreign keys need `map:` in the
 * schema). Prisma doesn't model partial indexes, exclusion constraints, triggers or check
 * constraints; their own integration tests cover those.
 */
describe('migration drift', () => {
  it('migrations and schema.prisma describe the same database', async () => {
    const db = await createOwnDatabase('migration_drift');
    const diff = spawnSync(
      process.execPath,
      [
        prismaCli(apiRoot),
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        join('prisma', 'schema.prisma'),
        '--script',
        '--exit-code',
      ],
      {
        cwd: apiRoot,
        env: { ...process.env, MIGRATION_DATABASE_URL: db.migrationDatabaseUrl },
        encoding: 'utf8',
      },
    );
    // --exit-code: 0 = no difference, 2 = difference (stdout is the SQL Prisma would generate),
    // anything else = the command failed (see stderr).
    expect(diff.status === 0 || diff.status === 2 ? '' : diff.stderr).toBe('');
    expect(diff.status === 2 ? diff.stdout : '').toBe('');
    expect(diff.status).toBe(0);
  }, 120_000);
});
