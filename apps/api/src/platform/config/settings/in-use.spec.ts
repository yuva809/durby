import { describe, expect, it, vi } from 'vitest';
import type { TenantTransactionClient } from '../../tenancy';
import { SettingInUseChecks } from './in-use';

const tx = {} as TenantTransactionClient;
const org = { type: 'organization' } as const;

describe('SettingInUseChecks', () => {
  it('runs only the checks of the key, until one reports data', async () => {
    const checks = new SettingInUseChecks();
    const other = vi.fn(() => Promise.resolve(true));
    const first = vi.fn(() => Promise.resolve(false));
    const second = vi.fn(() => Promise.resolve(true));
    checks.register({ key: 'inventory.valuationMethod', inUse: other });
    checks.register({ key: 'currency', inUse: first });
    checks.register({ key: 'currency', inUse: second });

    expect(await checks.anyInUse(tx, 'currency', org)).toBe(true);
    expect(first).toHaveBeenCalledWith(tx, org);
    expect(second).toHaveBeenCalledWith(tx, org);
    expect(other).not.toHaveBeenCalled();
    expect(await checks.anyInUse(tx, 'locale', org)).toBe(false);
  });

  it('refuses registrations after application bootstrap', () => {
    const checks = new SettingInUseChecks();
    checks.register({ key: 'currency', inUse: () => Promise.resolve(false) });
    checks.onApplicationBootstrap();
    expect(() => checks.register({ key: 'currency', inUse: () => Promise.resolve(false) })).toThrow(
      /registered after bootstrap: register it in onModuleInit/,
    );
  });
});
