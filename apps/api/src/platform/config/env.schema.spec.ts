import { describe, expect, it } from 'vitest';
import {
  appEnvSchema,
  configWarnings,
  migrationEnvSchema,
  RATE_LIMIT_DEFAULTS,
} from './env.schema';
import { loadConfig } from './load-config';

const validEnv = {
  DATABASE_URL: 'postgresql://durby_app:secret@localhost:5432/durby',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  WEB_ORIGINS: 'http://localhost:3000',
  WEB_BASE_URL: 'http://localhost:3000',
  SMTP_URL: 'smtp://localhost:1025',
  MAIL_FROM: 'Durby <no-reply@durby.test>',
  STAFF_EMAIL_DOMAINS: 'durby.test',
};

const without = (key: keyof typeof validEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(validEnv).filter(([k]) => k !== key));

describe('appEnvSchema', () => {
  describe('database pool and transactions (ADR 0021)', () => {
    it("defaults to the libraries' own values", () => {
      const env = appEnvSchema.parse(validEnv);
      expect([env.DATABASE_POOL_SIZE, env.PRISMA_TX_MAX_WAIT_MS, env.PRISMA_TX_TIMEOUT_MS]).toEqual(
        [10, 2000, 5000],
      );
    });

    it('reads and bounds them', () => {
      const env = appEnvSchema.parse({
        ...validEnv,
        DATABASE_POOL_SIZE: '20',
        PRISMA_TX_MAX_WAIT_MS: '3000',
        PRISMA_TX_TIMEOUT_MS: '8000',
      });
      expect([env.DATABASE_POOL_SIZE, env.PRISMA_TX_MAX_WAIT_MS, env.PRISMA_TX_TIMEOUT_MS]).toEqual(
        [20, 3000, 8000],
      );
      for (const bad of [
        { DATABASE_POOL_SIZE: '0' },
        { DATABASE_POOL_SIZE: '201' },
        { PRISMA_TX_MAX_WAIT_MS: '50' },
        { PRISMA_TX_TIMEOUT_MS: '500' },
      ]) {
        expect(appEnvSchema.safeParse({ ...validEnv, ...bad }).success, JSON.stringify(bad)).toBe(
          false,
        );
      }
    });
  });

  describe('staff settings (ADR 0017)', () => {
    it('reads the email domains as a lower-case list and needs at least one', () => {
      expect(
        appEnvSchema.parse({ ...validEnv, STAFF_EMAIL_DOMAINS: ' Durby.tech , durby.de' })
          .STAFF_EMAIL_DOMAINS,
      ).toEqual(['durby.tech', 'durby.de']);
      expect(appEnvSchema.safeParse({ ...validEnv, STAFF_EMAIL_DOMAINS: ' , ' }).success).toBe(
        false,
      );
      expect(
        appEnvSchema.safeParse({ ...validEnv, STAFF_EMAIL_DOMAINS: '@durby.tech' }).success,
      ).toBe(false);
    });

    it('caps staff sessions at 8 hours', () => {
      expect(appEnvSchema.parse(validEnv).STAFF_SESSION_TTL_SECONDS).toBe(28_800);
      expect(
        appEnvSchema.safeParse({ ...validEnv, STAFF_SESSION_TTL_SECONDS: '28801' }).success,
      ).toBe(false);
    });
  });

  it('applies defaults for optional vars', () => {
    expect(appEnvSchema.parse(validEnv)).toEqual({
      ...validEnv,
      WEB_ORIGINS: ['http://localhost:3000'],
      STAFF_EMAIL_DOMAINS: ['durby.test'],
      STAFF_SESSION_TTL_SECONDS: 28_800,
      NODE_ENV: 'development',
      PORT: 4000,
      APP_VERSION: '0.0.0-dev',
      LOG_LEVEL: 'info',
      DATABASE_POOL_SIZE: 10,
      PRISMA_TX_MAX_WAIT_MS: 2000,
      PRISMA_TX_TIMEOUT_MS: 5000,
      JWT_ACCESS_TTL_SECONDS: 600,
      JWT_ISSUER: 'durby-api',
      JWT_AUDIENCE: 'durby-web',
      REFRESH_TOKEN_TTL_DAYS: 14,
      REFRESH_FAMILY_MAX_DAYS: 30,
      COOKIE_SECURE: true,
      TRUST_PROXY: 0,
      OUTBOX_POLL_MS: 1000,
      OUTBOX_BATCH_SIZE: 100,
      OUTBOX_MAX_ATTEMPTS: 10,
      OUTBOX_LAG_WARN_SECONDS: 60,
      WORKER_CONCURRENCY: 5,
      REALTIME_HEARTBEAT_MS: 15_000,
      ...RATE_LIMIT_DEFAULTS,
    });
  });

  describe('auth rate limits', () => {
    const parse = (env: Record<string, string>) => appEnvSchema.safeParse({ ...validEnv, ...env });

    it("defaults to today's limits", () => {
      expect(RATE_LIMIT_DEFAULTS).toEqual({
        RATE_LIMIT_LOGIN_IP: 20,
        RATE_LIMIT_LOGIN_EMAIL: 10,
        RATE_LIMIT_REFRESH_IP: 60,
        RATE_LIMIT_MAIL_IP: 5,
        RATE_LIMIT_MAIL_EMAIL: 3,
        RATE_LIMIT_TOKEN_IP: 10,
      });
    });

    it('accepts raised limits (the Playwright run) and lower ones outside production', () => {
      expect(parse({ RATE_LIMIT_LOGIN_IP: '1000' }).data?.RATE_LIMIT_LOGIN_IP).toBe(1000);
      expect(parse({ RATE_LIMIT_LOGIN_IP: '2' }).data?.RATE_LIMIT_LOGIN_IP).toBe(2);
    });

    it('rejects non-positive and non-integer limits', () => {
      for (const value of ['0', '-1', '1.5', 'many']) {
        expect(parse({ RATE_LIMIT_MAIL_IP: value }).success, value).toBe(false);
      }
    });

    it('refuses limits below the defaults in production, and accepts higher ones', () => {
      const result = parse({
        NODE_ENV: 'production',
        RATE_LIMIT_LOGIN_IP: '19',
        RATE_LIMIT_TOKEN_IP: '9',
        RATE_LIMIT_LOGIN_EMAIL: '50',
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
        ['RATE_LIMIT_LOGIN_IP', 'must be at least 20 in production'],
        ['RATE_LIMIT_TOKEN_IP', 'must be at least 10 in production'],
      ]);
      expect(parse({ NODE_ENV: 'production', RATE_LIMIT_LOGIN_IP: '200' }).success).toBe(true);
    });
  });

  describe('auth', () => {
    const issuesOf = (env: Record<string, string>): string[] => {
      const result = appEnvSchema.safeParse({ ...validEnv, ...env });
      return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
    };

    it('requires a JWT secret of at least 32 characters', () => {
      expect(issuesOf({ JWT_ACCESS_SECRET: 'x'.repeat(31) })).toEqual(['JWT_ACCESS_SECRET']);
      expect(appEnvSchema.safeParse(without('JWT_ACCESS_SECRET')).success).toBe(false);
    });

    it('caps the access token lifetime at 15 minutes', () => {
      expect(issuesOf({ JWT_ACCESS_TTL_SECONDS: '901' })).toEqual(['JWT_ACCESS_TTL_SECONDS']);
      expect(issuesOf({ JWT_ACCESS_TTL_SECONDS: '900' })).toEqual([]);
    });

    it('parses WEB_ORIGINS as a list of bare origins', () => {
      expect(
        appEnvSchema.parse({ ...validEnv, WEB_ORIGINS: 'https://a.test, http://localhost:3000' })
          .WEB_ORIGINS,
      ).toEqual(['https://a.test', 'http://localhost:3000']);
      expect(issuesOf({ WEB_ORIGINS: 'https://a.test/' })).toEqual(['WEB_ORIGINS.0']);
      expect(issuesOf({ WEB_ORIGINS: 'https://a.test/app' })).toEqual(['WEB_ORIGINS.0']);
      expect(issuesOf({ WEB_ORIGINS: ' , ' })).toEqual(['WEB_ORIGINS']);
    });

    it('parses COOKIE_SECURE as a boolean and rejects false in production', () => {
      expect(appEnvSchema.parse({ ...validEnv, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
      expect(issuesOf({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toEqual([
        'COOKIE_SECURE',
      ]);
      expect(issuesOf({ NODE_ENV: 'production' })).toEqual([]);
    });

    it('keeps refresh tokens within the family lifetime', () => {
      expect(issuesOf({ REFRESH_TOKEN_TTL_DAYS: '31' })).toEqual(['REFRESH_TOKEN_TTL_DAYS']);
    });

    it('requires an smtp:// SMTP_URL', () => {
      expect(issuesOf({ SMTP_URL: 'http://localhost:1025' })).toEqual(['SMTP_URL']);
    });
  });

  it('coerces PORT to an integer', () => {
    expect(appEnvSchema.parse({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a non-numeric PORT', () => {
    expect(appEnvSchema.safeParse({ ...validEnv, PORT: 'http' }).success).toBe(false);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(appEnvSchema.safeParse(without('DATABASE_URL')).success).toBe(false);
  });

  it('rejects a DATABASE_URL that is not postgres', () => {
    const result = appEnvSchema.safeParse({ ...validEnv, DATABASE_URL: 'mysql://localhost/durby' });
    expect(result.success).toBe(false);
  });

  it('rejects a REDIS_URL that is not redis', () => {
    const result = appEnvSchema.safeParse({ ...validEnv, REDIS_URL: 'http://localhost:6379' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(appEnvSchema.safeParse({ ...validEnv, NODE_ENV: 'staging' }).success).toBe(false);
  });
});

describe('migrationEnvSchema', () => {
  it('requires a postgres MIGRATION_DATABASE_URL', () => {
    expect(migrationEnvSchema.safeParse({}).success).toBe(false);
    expect(
      migrationEnvSchema.parse({ MIGRATION_DATABASE_URL: 'postgres://m:p@localhost/durby' }),
    ).toEqual({ MIGRATION_DATABASE_URL: 'postgres://m:p@localhost/durby' });
  });
});

describe('loadConfig', () => {
  it('returns the parsed config', () => {
    expect(loadConfig(validEnv).DATABASE_URL).toBe(validEnv.DATABASE_URL);
  });

  it('lists every invalid var without leaking values', () => {
    const secret = 'mysql://user:topsecret@localhost/durby';
    const load = (): unknown => loadConfig({ DATABASE_URL: secret, PORT: 'x' });
    expect(load).toThrow(/DATABASE_URL/);
    expect(load).toThrow(/REDIS_URL/);
    expect(load).toThrow(/PORT/);
    expect(load).not.toThrow(/topsecret/);
  });

  it('reports a missing var as required', () => {
    expect(() => loadConfig(without('DATABASE_URL'))).toThrow(/DATABASE_URL: is required/);
  });
});

describe('configWarnings', () => {
  it('warns about Secure cookies over http origins, naming them', () => {
    const warnings = configWarnings(
      appEnvSchema.parse({ ...validEnv, WEB_ORIGINS: 'http://localhost:3000,https://a.test' }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('http://localhost:3000');
    expect(warnings[0]).not.toContain('https://a.test');
  });

  it('stays quiet with https only or with COOKIE_SECURE=false', () => {
    expect(
      configWarnings(appEnvSchema.parse({ ...validEnv, WEB_ORIGINS: 'https://a.test' })),
    ).toEqual([]);
    expect(configWarnings(appEnvSchema.parse({ ...validEnv, COOKIE_SECURE: 'false' }))).toEqual([]);
  });
});
