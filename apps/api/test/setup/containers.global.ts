import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { prismaCli } from '../support/prisma-cli';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    migrationDatabaseUrl: string;
    /** Superuser on the same server: only for tests that create their own databases. */
    superuserDatabaseUrl: string;
    redisUrl: string;
  }
}

const apiRoot = join(__dirname, '..', '..');
// Same scripts as docker-compose, so tests and local dev get identical roles.
const initDir = join(apiRoot, '..', '..', 'infra', 'postgres', 'init');
const roleScripts = ['01-roles.sql', '02-rls-definer.sql'];

let container: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  // Started in parallel with Postgres; same major version as docker-compose.
  const redisStarting = new RedisContainer('redis:8-alpine').start();

  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('durby')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyFilesToContainer(
      roleScripts.map((name) => ({
        source: join(initDir, name),
        target: `/docker-entrypoint-initdb.d/${name}`,
      })),
    )
    .start();

  const hostPort = `${container.getHost()}:${container.getPort()}`;
  const databaseUrl = `postgresql://durby_app:durby_app@${hostPort}/durby`;
  const migrationDatabaseUrl = `postgresql://durby_migrator:durby_migrator@${hostPort}/durby`;

  execFileSync(process.execPath, [prismaCli(apiRoot), 'migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationDatabaseUrl },
    stdio: 'pipe',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('migrationDatabaseUrl', migrationDatabaseUrl);
  project.provide('superuserDatabaseUrl', `postgresql://postgres:postgres@${hostPort}/durby`);

  redis = await redisStarting;
  project.provide('redisUrl', redis.getConnectionUrl());
}

export async function teardown(): Promise<void> {
  await Promise.all([container?.stop(), redis?.stop()]);
}
