import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { inject } from 'vitest';

const apiRoot = join(__dirname, '..', '..');

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface OwnDatabase {
  databaseUrl: string;
  migrationDatabaseUrl: string;
}

/**
 * A fresh, fully migrated database on the Testcontainers server, with the same roles and
 * database-level setup as `durby` (infra/postgres/init/01-roles.sql). For test files whose subject
 * reads across all tenants (outbox backlog, lag, cleanup): on the shared database their results
 * and run time would depend on what the other files write at the same time.
 */
export async function createOwnDatabase(
  name: string,
  opts: { before?: string } = {},
): Promise<OwnDatabase> {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) throw new Error(`bad database name: ${name}`);
  const database = `durby_${name}`;
  const superuser = new Client({ connectionString: inject('superuserDatabaseUrl') });
  await superuser.connect();
  try {
    await superuser.query(`DROP DATABASE IF EXISTS ${database}`);
    await superuser.query(`CREATE DATABASE ${database} OWNER durby_migrator`);
  } finally {
    await superuser.end();
  }
  const db = new Client({
    connectionString: withDatabase(inject('superuserDatabaseUrl'), database),
  });
  await db.connect();
  try {
    await db.query(`
      ALTER SCHEMA public OWNER TO durby_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${database} TO durby_app;`);
  } finally {
    await db.end();
  }

  const migrationDatabaseUrl = withDatabase(inject('migrationDatabaseUrl'), database);
  if (opts.before === undefined) {
    execFileSync(join(apiRoot, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: apiRoot,
      env: { ...process.env, MIGRATION_DATABASE_URL: migrationDatabaseUrl },
      stdio: 'pipe',
    });
  } else {
    // Migrated up to (not including) `before`, e.g. to test that migration on prepared data.
    await applyMigrations(migrationDatabaseUrl, (dir) => dir < (opts.before as string));
  }
  return { databaseUrl: withDatabase(inject('databaseUrl'), database), migrationDatabaseUrl };
}

const migrationsDir = join(apiRoot, 'prisma', 'migrations');

/** The migration folders in order (their names start with a timestamp). */
export function migrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** The SQL of one migration. */
export const migrationSql = (name: string): string =>
  readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');

async function applyMigrations(url: string, include: (dir: string) => boolean): Promise<void> {
  const migrator = new Client({ connectionString: url });
  await migrator.connect();
  try {
    for (const name of migrationNames().filter(include)) await migrator.query(migrationSql(name));
  } finally {
    await migrator.end();
  }
}

/** Points the app config (read when a Nest app boots) at `db`; call before compiling AppModule. */
export function useDatabase(db: OwnDatabase): void {
  process.env.DATABASE_URL = db.databaseUrl;
  process.env.MIGRATION_DATABASE_URL = db.migrationDatabaseUrl;
}
