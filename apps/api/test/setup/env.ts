import { inject } from 'vitest';

// Point the app config at the Testcontainers Postgres before any module boots.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.MIGRATION_DATABASE_URL = inject('migrationDatabaseUrl');
// Required by config validation; nothing connects to Redis yet.
process.env.REDIS_URL ??= 'redis://localhost:6379';
