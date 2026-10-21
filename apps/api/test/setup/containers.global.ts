import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    migrationDatabaseUrl: string;
    redisUrl: string;
  }
}

const apiRoot = join(__dirname, '..', '..');
// Same script as docker-compose, so tests and local dev get identical roles.
const rolesScript = join(apiRoot, '..', '..', 'infra', 'postgres', 'init', '01-roles.sql');

let container: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  // Started in parallel with Postgres; same major version as docker-compose.
  const redisStarting = new RedisContainer('redis:8-alpine').start();

  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('durby')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyFilesToContainer([
      { source: rolesScript, target: '/docker-entrypoint-initdb.d/01-roles.sql' },
    ])
    .start();

  const hostPort = `${container.getHost()}:${container.getPort()}`;
  const databaseUrl = `postgresql://durby_app:durby_app@${hostPort}/durby`;
  const migrationDatabaseUrl = `postgresql://durby_migrator:durby_migrator@${hostPort}/durby`;

  execFileSync(join(apiRoot, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    cwd: apiRoot,
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationDatabaseUrl },
    stdio: 'pipe',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('migrationDatabaseUrl', migrationDatabaseUrl);

  redis = await redisStarting;
  project.provide('redisUrl', redis.getConnectionUrl());
}

export async function teardown(): Promise<void> {
  await Promise.all([container?.stop(), redis?.stop()]);
}
