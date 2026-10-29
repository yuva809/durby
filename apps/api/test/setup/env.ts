import { inject } from 'vitest';

// Point the app config at the Testcontainers Postgres and Redis before any module boots.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.MIGRATION_DATABASE_URL = inject('migrationDatabaseUrl');
process.env.REDIS_URL = inject('redisUrl');
process.env.LOG_LEVEL ??= 'silent';
// Auth and mail: test-only values. Mail goes to InMemoryMailer in tests that send any.
process.env.JWT_ACCESS_SECRET = 'test-only-jwt-secret-0123456789abcdef';
process.env.WEB_ORIGINS = 'http://web.test';
process.env.WEB_BASE_URL = 'http://web.test';
process.env.SMTP_URL = 'smtp://127.0.0.1:1';
process.env.MAIL_FROM = 'Durby <no-reply@durby.test>';
process.env.STAFF_EMAIL_DOMAINS = 'durby.test';
// One trusted proxy: e2e tests give each test its own client IP via X-Forwarded-For.
process.env.TRUST_PROXY = '1';
