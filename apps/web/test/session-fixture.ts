import type { Session } from '../lib/auth/session';

/** A signed-in session for component tests. */
export function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    user: { id: '0190a000-0000-7000-8000-000000000001', email: 'owner@example.test', locale: 'en' },
    organizations: [{ id: '0190a000-0000-7000-8000-0000000000a1', name: 'Demo Bistro' }],
    activeOrganizationId: '0190a000-0000-7000-8000-0000000000a1',
    activeRole: null,
    activePermissions: [],
    activeFeatures: [],
    accessToken: 'token',
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}
