import { createTranslator } from '@durby/i18n';
import { vi } from 'vitest';
import type { Accounts } from '../app/providers';
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
  accounts: {
    list: [] as Accounts['list'],
    current: 0,
    slotFor: vi.fn<Accounts['slotFor']>(),
    switchTo: vi.fn<Accounts['switchTo']>(),
    signOut: vi.fn<Accounts['signOut']>(),
    signOutAll: vi.fn<Accounts['signOutAll']>(),
  },
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
  mockState.accounts.list = [];
  mockState.accounts.current = 0;
  mockState.accounts.slotFor.mockReset().mockReturnValue(1);
  mockState.accounts.switchTo.mockReset().mockResolvedValue({ ok: true });
  mockState.accounts.signOut.mockReset().mockResolvedValue(false);
  mockState.accounts.signOutAll.mockReset().mockResolvedValue(undefined);
  mockState.reloadLabels.mockReset();
  mockState.router.push.mockReset();
  mockState.router.replace.mockReset();
}

export const providersMock = () => ({
  useAuth: () => ({ store: mockState.store, session: mockState.session, status: mockState.status }),
  useAccounts: () => mockState.accounts,
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
