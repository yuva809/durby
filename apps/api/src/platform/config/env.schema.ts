import { z } from 'zod';

const urlError = (scheme: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? 'is required' : `must be a ${scheme}:// URL`;

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: urlError('postgres') });
const redisUrl = z.url({ protocol: /^rediss?$/, error: urlError('redis') });

/** Env vars read by the running API. Validated once at boot. */
export const appEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  APP_VERSION: z.string().min(1).default('0.0.0-dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Connects as durby_app (no BYPASSRLS). */
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
});

/** Env vars read by the Prisma CLI (prisma.config.ts). Never used by the running API. */
export const migrationEnvSchema = z.object({
  /** Connects as durby_migrator (schema owner). */
  MIGRATION_DATABASE_URL: postgresUrl,
});

export type AppConfig = z.infer<typeof appEnvSchema>;
