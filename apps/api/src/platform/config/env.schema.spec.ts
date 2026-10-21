import { describe, expect, it } from 'vitest';
import { appEnvSchema, migrationEnvSchema } from './env.schema';
import { loadConfig } from './load-config';

const validEnv = {
  DATABASE_URL: 'postgresql://durby_app:secret@localhost:5432/durby',
  REDIS_URL: 'redis://localhost:6379',
};

describe('appEnvSchema', () => {
  it('applies defaults for optional vars', () => {
    expect(appEnvSchema.parse(validEnv)).toEqual({
      ...validEnv,
      NODE_ENV: 'development',
      PORT: 4000,
      APP_VERSION: '0.0.0-dev',
      LOG_LEVEL: 'info',
    });
  });

  it('coerces PORT to an integer', () => {
    expect(appEnvSchema.parse({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a non-numeric PORT', () => {
    expect(appEnvSchema.safeParse({ ...validEnv, PORT: 'http' }).success).toBe(false);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(appEnvSchema.safeParse({ REDIS_URL: validEnv.REDIS_URL }).success).toBe(false);
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
    expect(() => loadConfig({ REDIS_URL: validEnv.REDIS_URL })).toThrow(
      /DATABASE_URL: is required/,
    );
  });
});
