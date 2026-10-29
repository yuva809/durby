// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { OrgSwitcher } from './org-switcher';
import { SidebarNav } from './sidebar-nav';
import { UserMenu } from './user-menu';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const BISTRO = '0190a000-0000-7000-8000-0000000000a1';
const CAFE = '0190a000-0000-7000-8000-0000000000a2';

describe('SidebarNav', () => {
  it('shows only the modules of the active organization, with its labels', () => {
    mockState.session = sessionFixture({
      activeFeatures: ['catalog', 'inventory', 'reports'],
      activePermissions: ['catalog.products.read', 'pos.orders.read'],
    });
    mockState.overrides = { 'catalog.nav.title': 'Menu' };
    render(<SidebarNav />);
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByTestId('nav-catalog').textContent).toBe('Menu');
    // No pos feature on this plan: no Service.
    expect(within(nav).queryByTestId('nav-service')).toBeNull();
    // Not built yet: hidden even with their feature.
    expect(within(nav).queryByTestId('nav-inventory')).toBeNull();
    expect(within(nav).queryByTestId('nav-reports')).toBeNull();
  });

  it('hides a group without visible items', () => {
    mockState.session = sessionFixture({ activeFeatures: [] });
    render(<SidebarNav />);
    expect(screen.queryByText('Modules')).toBeNull();
    expect(screen.getByTestId('nav-home')).toBeTruthy();
  });

  it('marks the current page, also on sub-paths', () => {
    mockState.session = sessionFixture({ activeFeatures: [] });
    mockState.pathname = '/settings/members';
    render(<SidebarNav />);
    expect(screen.getByTestId('nav-settings').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-home').getAttribute('aria-current')).toBeNull();
  });

  it('calls onNavigate when an item is chosen (closes the drawer)', async () => {
    mockState.session = sessionFixture();
    const onNavigate = vi.fn((e: Event) => e.preventDefault());
    render(<SidebarNav onNavigate={() => onNavigate(new Event('click'))} />);
    await userEvent.click(screen.getByTestId('nav-home'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('OrgSwitcher', () => {
  it('shows the organization name as text when there is only one', () => {
    mockState.session = sessionFixture();
    render(<OrgSwitcher />);
    expect(screen.getByTestId('organization').textContent).toBe('Demo Bistro');
    expect(screen.queryByTestId('organization-switcher')).toBeNull();
  });

  it('switches organization from the menu and goes home', async () => {
    mockState.session = sessionFixture({
      organizations: [
        { id: BISTRO, name: 'Demo Bistro' },
        { id: CAFE, name: 'Demo Café' },
      ],
    });
    render(<OrgSwitcher />);
    await userEvent.click(screen.getByTestId('organization-switcher'));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Demo Café' }));
    expect(mockState.store.switchOrganization).toHaveBeenCalledWith(CAFE);
    await waitFor(() => expect(mockState.router.push).toHaveBeenCalledWith('/'));
  });

  it('shows the error label when the switch fails', async () => {
    mockState.session = sessionFixture({
      organizations: [
        { id: BISTRO, name: 'Demo Bistro' },
        { id: CAFE, name: 'Demo Café' },
      ],
    });
    mockState.store.switchOrganization.mockResolvedValue({ ok: false, code: 'unknown' });
    render(<OrgSwitcher />);
    await userEvent.click(screen.getByTestId('organization-switcher'));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Demo Café' }));
    expect((await screen.findByRole('alert')).textContent).not.toBe('');
    expect(mockState.router.push).not.toHaveBeenCalled();
  });
});

describe('UserMenu', () => {
  it('shows the user and signs out to the login page', async () => {
    mockState.session = sessionFixture();
    render(<UserMenu />);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect((await screen.findByTestId('user-email')).textContent).toBe('owner@example.test');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(mockState.store.logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockState.router.replace).toHaveBeenCalledWith('/login'));
  });
});
