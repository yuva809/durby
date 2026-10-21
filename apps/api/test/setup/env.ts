import { inject } from 'vitest';

// Point the app config at the Testcontainers Postgres and Redis before any module boots.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.MIGRATION_DATABASE_URL = inject('migrationDatabaseUrl');
process.env.REDIS_URL = inject('redisUrl');
process.env.LOG_LEVEL ??= 'silent';
