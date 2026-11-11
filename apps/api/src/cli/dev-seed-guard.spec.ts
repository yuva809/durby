import { describe, expect, it } from 'vitest';
import { assertDevSeedAllowed, devSeedRefusal } from './dev-seed-guard';

// seed-dev creates accounts with known passwords: it must never run on staging or production.
describe('dev seed guard', () => {
  it('refuses without the opt-in flag', () => {
    expect(devSeedRefusal({ NODE_ENV: 'development' })).toMatch(/without DURBY_ALLOW_DEV_SEED=1/);
    expect(
      devSeedRefusal({ NODE_ENV: 'development', DURBY_ALLOW_DEV_SEED: 'true' }),
    ).not.toBeNull();
    expect(() => assertDevSeedAllowed({})).toThrow(/DURBY_ALLOW_DEV_SEED/);
  });

  it('refuses with the flag when NODE_ENV=production', () => {
    expect(devSeedRefusal({ NODE_ENV: 'production', DURBY_ALLOW_DEV_SEED: '1' })).toBe(
      'seed-dev refuses to run with NODE_ENV=production',
    );
  });

  it('runs with the flag in development and test', () => {
    expect(devSeedRefusal({ NODE_ENV: 'development', DURBY_ALLOW_DEV_SEED: '1' })).toBeNull();
    expect(devSeedRefusal({ NODE_ENV: 'test', DURBY_ALLOW_DEV_SEED: '1' })).toBeNull();
    expect(() =>
      assertDevSeedAllowed({ NODE_ENV: 'development', DURBY_ALLOW_DEV_SEED: '1' }),
    ).not.toThrow();
  });
});
