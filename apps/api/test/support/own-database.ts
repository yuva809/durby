import { execFileSync } from 'node:child_process';
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
export async function createOwnDatabase(name: string): Promise<OwnDatabase> {
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
  execFileSync(join(apiRoot, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationDatabaseUrl },
    stdio: 'pipe',
  });
  return { databaseUrl: withDatabase(inject('databaseUrl'), database), migrationDatabaseUrl };
}

/** Points the app config (read when a Nest app boots) at `db`; call before compiling AppModule. */
export function useDatabase(db: OwnDatabase): void {
  process.env.DATABASE_URL = db.databaseUrl;
  process.env.MIGRATION_DATABASE_URL = db.migrationDatabaseUrl;
}
