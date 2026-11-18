import { z } from 'zod';

const urlError = (scheme: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? 'is required' : `must be a ${scheme}:// URL`;

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: urlError('postgres') });
const redisUrl = z.url({ protocol: /^rediss?$/, error: urlError('redis') });
const smtpUrl = z.url({ protocol: /^smtps?$/, error: urlError('smtp') });
const httpUrl = z.url({ protocol: /^https?$/, error: urlError('http(s)') });

/** Comma-separated list of exact origins (scheme://host[:port], no path), compared as-is with `Origin`. */
const originList = z
  .string({ error: 'is required' })
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(
        z.url({ protocol: /^https?$/ }).refine((entry) => new URL(entry).origin === entry, {
          error:
            'entries must be bare origins like https://app.example.com (no path or trailing slash)',
        }),
      )
      .min(1, 'needs at least one origin'),
  );

/** Comma-separated email domains, lower-case, without `@` (e.g. `durby.tech,durby.de`). */
const domainList = z
  .string({ error: 'is required' })
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'entries must be domains like durby.tech'),
      )
      .min(1, 'needs at least one domain'),
  );

/**
 * Counts of the auth rate limits (docs/platform/auth.md → Rate limits); the windows are fixed in
 * code. Production may only be stricter than these defaults (ADR 0015 §14): the Playwright run
 * raises them so end-to-end suites don't hit 429.
 */
export const RATE_LIMIT_DEFAULTS = {
  RATE_LIMIT_LOGIN_IP: 20,
  RATE_LIMIT_LOGIN_EMAIL: 10,
  RATE_LIMIT_REFRESH_IP: 60,
  RATE_LIMIT_MAIL_IP: 5,
  RATE_LIMIT_MAIL_EMAIL: 3,
  RATE_LIMIT_TOKEN_IP: 10,
} as const;

const rateLimit = (fallback: number) =>
  z.coerce.number().int().min(1).max(1_000_000).default(fallback);

/** Env vars read by the running API. Validated once at boot. */
export const appEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    APP_VERSION: z.string().min(1).default('0.0.0-dev'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** Connects as durby_app (no BYPASSRLS). */
    DATABASE_URL: postgresUrl,
    // Database pool and Prisma interactive transactions (ADR 0021). Defaults are the libraries'
    // own (pg: 10, Prisma: 2000 / 5000 ms); change only after measuring (db.pool log).
    /** Connections per process (api and worker each have their own pool). */
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
    /** How long a transaction waits for a pooled connection before 503 platform.busy. */
    PRISMA_TX_MAX_WAIT_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
    /** How long an interactive transaction may run before it is rolled back (503 platform.busy). */
    PRISMA_TX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(5000),
    REDIS_URL: redisUrl,

    // Auth (docs/platform/auth.md). HS256 secret: `openssl rand -hex 32`.
    JWT_ACCESS_SECRET: z
      .string({ error: 'is required' })
      .min(32, 'must be at least 32 characters (openssl rand -hex 32)'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
    JWT_ISSUER: z.string().min(1).default('durby-api'),
    JWT_AUDIENCE: z.string().min(1).default('durby-web'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    REFRESH_FAMILY_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** Origins allowed to call the cookie endpoints (CSRF check). */
    WEB_ORIGINS: originList,
    /** Base of links in emails (reset, verification). */
    WEB_BASE_URL: httpUrl,
    /** false only for local browsers that reject Secure cookies on http://localhost; never in production. */
    COOKIE_SECURE: z.stringbool().default(true),
    /** Number of reverse proxies in front of the api (Express `trust proxy`), for the client IP. */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    SMTP_URL: smtpUrl,
    MAIL_FROM: z.string({ error: 'is required' }).min(3),

    // Browser push (docs/platform/notifications.md, ADR 0047): VAPID keys from `npx web-push generate-vapid-keys`.
    // All three or none; without them push is off and the bell and email still work.
    WEB_PUSH_PUBLIC_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{80,100}$/, 'must be a base64url VAPID public key')
      .optional(),
    WEB_PUSH_PRIVATE_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{40,50}$/, 'must be a base64url VAPID private key')
      .optional(),
    /** Who push services may contact about our messages: mailto:… or https://… */
    WEB_PUSH_SUBJECT: z
      .string()
      .regex(/^(mailto:|https:\/\/)\S+$/, 'must start with mailto: or https://')
      .optional(),

    // Durby staff and the admin portal (docs/platform/admin-portal.md, ADR 0017).
    /** Only these domains can be invited as staff. */
    STAFF_EMAIL_DOMAINS: domainList,
    /** Absolute lifetime of a staff session; at most 8 hours. */
    STAFF_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(28_800).default(28_800),

    // Outbox worker (docs/platform/outbox.md → Worker process). Read only by src/worker.ts.
    OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
    OUTBOX_LAG_WARN_SECONDS: z.coerce.number().int().min(1).default(60),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),

    // Live updates (docs/platform/realtime.md, ADR 0044): ping interval of open streams.
    REALTIME_HEARTBEAT_MS: z.coerce.number().int().min(100).max(60_000).default(15_000),

    // Auth rate limits (counts per window).
    RATE_LIMIT_LOGIN_IP: rateLimit(RATE_LIMIT_DEFAULTS.RATE_LIMIT_LOGIN_IP),
    RATE_LIMIT_LOGIN_EMAIL: rateLimit(RATE_LIMIT_DEFAULTS.RATE_LIMIT_LOGIN_EMAIL),
    RATE_LIMIT_REFRESH_IP: rateLimit(RATE_LIMIT_DEFAULTS.RATE_LIMIT_REFRESH_IP),
    RATE_LIMIT_MAIL_IP: rateLimit(RATE_LIMIT_DEFAULTS.RATE_LIMIT_MAIL_IP),
    RATE_LIMIT_MAIL_EMAIL: rateLimit(RATE_LIMIT_DEFAULTS.RATE_LIMIT_MAIL_EMAIL),
    RATE_LIMIT_TOKEN_IP: rateLimit(RATE_LIMIT_DEFAULTS.RATE_LIMIT_TOKEN_IP),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
    if (env.NODE_ENV === 'production') {
      for (const [name, floor] of Object.entries(RATE_LIMIT_DEFAULTS)) {
        if (env[name as keyof typeof RATE_LIMIT_DEFAULTS] < floor) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: `must be at least ${floor} in production`,
          });
        }
      }
    }
    const push = [env.WEB_PUSH_PUBLIC_KEY, env.WEB_PUSH_PRIVATE_KEY, env.WEB_PUSH_SUBJECT];
    if (push.some((v) => v !== undefined) && push.some((v) => v === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_PUSH_PUBLIC_KEY'],
        message:
          'set WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_SUBJECT together, or none',
      });
    }
    if (env.REFRESH_TOKEN_TTL_DAYS > env.REFRESH_FAMILY_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['REFRESH_TOKEN_TTL_DAYS'],
        message: 'must not exceed REFRESH_FAMILY_MAX_DAYS',
      });
    }
  });

/** Env vars read by the Prisma CLI (prisma.config.ts). Never used by the running API. */
export const migrationEnvSchema = z.object({
  /** Connects as durby_migrator (schema owner). */
  MIGRATION_DATABASE_URL: postgresUrl,
});

export type AppConfig = z.infer<typeof appEnvSchema>;

/**
 * Settings that boot but are likely wrong, logged as warnings at start. Secure cookies over plain http: desktop
 * Chromium and Firefox keep them on `http://localhost`, but the Android app's WebView, Safari and any other http
 * origin drop them, so every reload signs out.
 */
export function configWarnings(env: Pick<AppConfig, 'COOKIE_SECURE' | 'WEB_ORIGINS'>): string[] {
  const http = env.WEB_ORIGINS.filter((origin) => origin.startsWith('http://'));
  if (!env.COOKIE_SECURE || http.length === 0) return [];
  return [
    `COOKIE_SECURE=true with http origins (${http.join(', ')}): the Android app's WebView, Safari and ` +
      'non-localhost http origins drop the Secure refresh cookie, so every reload signs out. ' +
      'Set COOKIE_SECURE=false for local testing with them (never in production).',
  ];
}
