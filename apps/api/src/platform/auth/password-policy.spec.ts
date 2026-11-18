import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '../tenancy';
import { PasswordPolicy } from './password-policy';

const ORG = '0190a000-0000-7000-8000-000000000001';
const USER = '0190a000-0000-7000-8000-000000000002';

/** The setting per organization; `run` records which organization the read happened in. */
function policy(on: Record<string, boolean>) {
  let current: string | null = null;
  const tenantContext = {
    run: vi.fn(async (ctx: { tenantId: string }, fn: () => PromiseLike<boolean>) => {
      current = ctx.tenantId;
      try {
        return await fn();
      } finally {
        current = null;
      }
    }),
  } as unknown as TenantContext;
  const settings = { get: vi.fn(() => Promise.resolve(current !== null && on[current] === true)) };
  return { policy: new PasswordPolicy(settings, tenantContext), settings };
}

describe('PasswordPolicy (ADR 0052)', () => {
  it('manages an account where the organization that created it sets passwords', async () => {
    const { policy: p } = policy({ [ORG]: true });
    expect(await p.managed({ id: USER, vouchedByOrganizationId: ORG })).toBe(true);
    expect(
      await p.changeRequired({ id: USER, mustChangePassword: true, vouchedByOrganizationId: ORG }),
    ).toBe(false);
  });

  it('keeps temporary passwords where the setting is off', async () => {
    const { policy: p } = policy({});
    expect(
      await p.changeRequired({ id: USER, mustChangePassword: true, vouchedByOrganizationId: ORG }),
    ).toBe(true);
  });

  it('never manages accounts that signed up or joined by invitation', async () => {
    const { policy: p, settings } = policy({ [ORG]: true });
    expect(await p.managed({ id: USER, vouchedByOrganizationId: null })).toBe(false);
    expect(
      await p.changeRequired({
        id: USER,
        mustChangePassword: false,
        vouchedByOrganizationId: null,
      }),
    ).toBe(false);
    expect(settings.get).not.toHaveBeenCalled();
  });
});
