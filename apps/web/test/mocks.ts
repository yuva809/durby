import { createTranslator } from '@durby/i18n';
import { vi } from 'vitest';
import type { Session, SessionStore } from '../lib/auth/session';

/** Shared state behind the mocked useAuth / useT / next/navigation of component tests. */
export const mockState = {
  session: null as Session | null,
  status: 'authenticated' as 'loading' | 'authenticated' | 'anonymous',
  pathname: '/',
  search: '',
  overrides: {} as Record<string, string>,
  store: {
    switchOrganization: vi.fn<SessionStore['switchOrganization']>(),
    changePassword: vi.fn<SessionStore['changePassword']>(),
    logout: vi.fn<SessionStore['logout']>(),
    refresh: vi.fn<SessionStore['refresh']>(),
    apiFetch: vi.fn<SessionStore['apiFetch']>(),
  },
  router: { push: vi.fn(), replace: vi.fn() },
  reloadLabels: vi.fn(),
};

export function resetMocks(): void {
  mockState.session = null;
  mockState.status = 'authenticated';
  mockState.pathname = '/';
  mockState.search = '';
  mockState.overrides = {};
  mockState.store.switchOrganization.mockReset().mockResolvedValue({ ok: true });
  mockState.store.logout.mockReset().mockResolvedValue(undefined);
  mockState.store.refresh.mockReset().mockResolvedValue({ ok: true });
  // A fresh Response per call: a body can be read only once.
  mockState.store.apiFetch
    .mockReset()
    .mockImplementation(() => Promise.resolve(Response.json({ data: [] })));
  mockState.reloadLabels.mockReset();
  mockState.router.push.mockReset();
  mockState.router.replace.mockReset();
}

export const providersMock = () => ({
  useAuth: () => ({ store: mockState.store, session: mockState.session, status: mockState.status }),
});

export const labelsMock = () => ({
  useT: () => createTranslator('en', mockState.overrides),
  useReloadLabels: () => mockState.reloadLabels,
});

export const navigationMock = () => ({
  usePathname: () => mockState.pathname,
  useSearchParams: () => new URLSearchParams(mockState.search),
  useRouter: () => mockState.router,
});
