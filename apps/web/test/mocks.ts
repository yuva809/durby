import { createTranslator } from '@durby/i18n';
import { vi } from 'vitest';
import type { Session, SessionStore } from '../lib/auth/session';

/** Shared state behind the mocked useAuth / useT / next/navigation of component tests. */
export const mockState = {
  session: null as Session | null,
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous',
  pathname: '/',
  overrides: {} as Record<string, string>,
  store: {
    switchOrganization: vi.fn<SessionStore['switchOrganization']>(),
    logout: vi.fn<SessionStore['logout']>(),
  },
  router: { push: vi.fn(), replace: vi.fn() },
};

export function resetMocks(): void {
  mockState.session = null;
  mockState.status = 'authenticated';
  mockState.pathname = '/';
  mockState.overrides = {};
  mockState.store.switchOrganization.mockReset().mockResolvedValue({ ok: true });
  mockState.store.logout.mockReset().mockResolvedValue(undefined);
  mockState.router.push.mockReset();
  mockState.router.replace.mockReset();
}

export const providersMock = () => ({
  useAuth: () => ({ store: mockState.store, session: mockState.session, status: mockState.status }),
});

export const labelsMock = () => ({
  useT: () => createTranslator('en', mockState.overrides),
});

export const navigationMock = () => ({
  usePathname: () => mockState.pathname,
  useRouter: () => mockState.router,
});
