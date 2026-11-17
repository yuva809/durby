// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { BrandProvider } from '../theme-provider';
import { AccountCard, initialsOf } from './account-card';
import { AppShell } from './app-shell';
import { NotificationsBell } from './notifications-bell';
import { SearchBox } from './search-box';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ORG_A = { id: '0190a000-0000-7000-8000-0000000000a1', name: 'Demo Bistro' };
const ORG_B = { id: '0190a000-0000-7000-8000-0000000000b2', name: 'AsiaMight' };

function signedIn(permissions: string[] = [], organizations = [ORG_A]) {
  mockState.session = sessionFixture({
    activePermissions: permissions,
    activeFeatures: ['inventory', 'catalog', 'orders'],
    organizations,
  });
}

function api(answers: Record<string, unknown>) {
  mockState.store.apiFetch.mockImplementation((input: string) => {
    const path = input.split('?')[0]!;
    return Promise.resolve(Response.json(answers[path] ?? { data: [] }));
  });
}

describe('search (ADR 0046)', () => {
  it('lists the pages the person can open, and finds records from two letters', async () => {
    signedIn(['inventory.stock.read', 'orders.orders.read']);
    api({
      '/api/v1/search': {
        data: [
          { type: 'stock_item', id: 'i1', title: 'Basmati rice', subtitle: 'RICE-5' },
          { type: 'sales_order', id: 'o1', title: 'SO-2026-000001', subtitle: 'Lotus Mart' },
        ],
      },
    });
    render(<SearchBox />);
    await userEvent.click(screen.getByTestId('search-open'));
    const results = await screen.findByTestId('search-results');
    // No settings permission here, but the Settings item needs none; Audit log needs one.
    expect(results.textContent).toContain('Inventory');
    expect(results.textContent).not.toContain('Audit log');

    await userEvent.type(screen.getByTestId('search-input'), 'ri');
    await waitFor(() =>
      expect(screen.getByTestId('search-results').textContent).toContain('Basmati rice'),
    );
    expect(screen.getByText('Stock items')).toBeTruthy();
    expect(mockState.store.apiFetch).toHaveBeenCalledWith('/api/v1/search?q=ri', expect.anything());

    // Arrow down past nothing else, then Enter opens the order in its panel.
    const options = screen.getAllByTestId('search-result');
    await userEvent.click(options[options.length - 1]!);
    expect(mockState.router.push).toHaveBeenCalledWith('/orders?open=o1');
  });

  it('opens with Ctrl+K and picks with the keyboard', async () => {
    signedIn(['inventory.stock.read']);
    api({});
    render(<SearchBox />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByTestId('search-input');
    await userEvent.type(input, 'inv');
    await userEvent.keyboard('{Enter}');
    expect(mockState.router.push).toHaveBeenCalledWith('/inventory');
  });
});

describe('notifications bell (ADR 0046)', () => {
  it('shows the count and what waits, and opens where it is dealt with', async () => {
    signedIn(['orders.requests.approve']);
    api({
      '/api/v1/attention': {
        data: [
          { kind: 'requests_to_approve', count: 2 },
          { kind: 'low_stock', count: 3 },
        ],
        total: 5,
      },
    });
    render(<NotificationsBell />);
    expect((await screen.findByTestId('attention-count')).textContent).toBe('5');
    expect(screen.getByTestId('attention-bell').getAttribute('aria-label')).toBe(
      'Notifications, 5 waiting',
    );
    await userEvent.click(screen.getByTestId('attention-bell'));
    const items = await screen.findAllByTestId('attention-item');
    expect(items.map((i) => i.textContent)).toEqual([
      'Stock requests to approve2',
      'Items at or below their reorder level3',
    ]);
    await userEvent.click(items[0]!);
    expect(mockState.router.push).toHaveBeenCalledWith('/requests');
  });

  it('says when nothing waits', async () => {
    signedIn();
    api({
      '/api/v1/attention': { data: [], total: 0 },
      '/api/v1/notifications': { data: [], unread: 0 },
    });
    render(<NotificationsBell />);
    await userEvent.click(await screen.findByTestId('attention-bell'));
    expect(await screen.findByTestId('attention-empty')).toBeTruthy();
    expect(screen.queryByTestId('attention-count')).toBeNull();
  });
});

describe('notifications bell: updates (ADR 0047)', () => {
  const REQUEST_ID = '0190a000-0000-7000-8000-000000000101';
  const updates = {
    data: [
      {
        id: '0190a000-0000-7000-8000-000000000201',
        kind: 'request_approved',
        entityType: 'stock_request',
        entityId: REQUEST_ID,
        params: { number: 'TRF-2026-000004', branch: 'Branch Nord' },
        readAt: null,
        createdAt: '2026-11-18T09:00:00.000Z',
      },
      {
        id: '0190a000-0000-7000-8000-000000000202',
        kind: 'feedback_answered',
        entityType: 'feedback',
        entityId: '0190a000-0000-7000-8000-000000000301',
        params: { status: 'done' },
        readAt: '2026-11-18T08:00:00.000Z',
        createdAt: '2026-11-17T09:00:00.000Z',
      },
    ],
    unread: 1,
  };

  it('adds unread updates to the badge, opens one and marks it read', async () => {
    signedIn();
    api({ '/api/v1/attention': { data: [], total: 0 }, '/api/v1/notifications': updates });
    render(<NotificationsBell />);
    expect((await screen.findByTestId('attention-count')).textContent).toBe('1');
    // Nothing waits but there is news: the menu opens on Updates.
    await userEvent.click(screen.getByTestId('attention-bell'));
    const items = await screen.findAllByTestId('update-item');
    expect(items[0]!.textContent).toContain('Your stock request was approved: TRF-2026-000004');
    expect(items[0]!.getAttribute('data-unread')).toBe('true');
    expect(items[1]!.textContent).toContain('Your feedback was dealt with by our team');
    expect(items[1]!.getAttribute('data-unread')).toBeNull();

    await userEvent.click(items[0]!);
    expect(mockState.router.push).toHaveBeenCalledWith(`/requests?open=${REQUEST_ID}`);
    expect(mockState.store.apiFetch).toHaveBeenCalledWith(
      `/api/v1/notifications/${updates.data[0]!.id}/read`,
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(screen.queryByTestId('attention-count')).toBeNull());
  });

  it('marks all as read', async () => {
    signedIn();
    api({ '/api/v1/attention': { data: [], total: 0 }, '/api/v1/notifications': updates });
    render(<NotificationsBell />);
    await screen.findByTestId('attention-count');
    await userEvent.click(screen.getByTestId('attention-bell'));
    await userEvent.click(await screen.findByTestId('updates-read-all'));
    expect(mockState.store.apiFetch).toHaveBeenCalledWith(
      '/api/v1/notifications/read-all',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByTestId('updates-read-all')).toBeNull();
    expect(screen.queryByTestId('attention-count')).toBeNull();
  });
});

describe('account card (ADR 0046)', () => {
  it('shows who and where, switches organization and signs out', async () => {
    signedIn([], [ORG_A, ORG_B]);
    mockState.store.switchOrganization.mockResolvedValue({ ok: true });
    render(<AccountCard />);
    const card = screen.getByTestId('account-card');
    expect(within(card).getByTestId('organization').textContent).toBe('Demo Bistro');
    await userEvent.click(card);
    const orgs = await screen.findAllByTestId('account-organization');
    expect(orgs.map((o) => o.textContent)).toEqual(['Demo Bistro', 'AsiaMight']);
    await userEvent.click(orgs[1]!);
    await waitFor(() => expect(mockState.store.switchOrganization).toHaveBeenCalledWith(ORG_B.id));
    expect(mockState.router.push).toHaveBeenCalledWith('/');

    await userEvent.click(screen.getByTestId('account-card'));
    await userEvent.click(await screen.findByTestId('sign-out'));
    await waitFor(() => expect(mockState.store.logout).toHaveBeenCalled());
  });

  it('makes initials from the email', () => {
    expect(initialsOf('anna.weber@example.com')).toBe('AW');
    expect(initialsOf('owner@example.com')).toBe('O');
  });
});

describe('top bar', () => {
  it('shows the Audit log shortcut only to those who read it', () => {
    signedIn(['platform.audit.read']);
    api({});
    const { unmount } = render(
      <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>
        <AppShell>page</AppShell>
      </BrandProvider>,
    );
    expect(screen.getByTestId('topbar-audit').getAttribute('href')).toBe('/audit');
    unmount();
    signedIn([]);
    render(
      <BrandProvider brand={{ productName: 'Product', logoUrl: null }}>
        <AppShell>page</AppShell>
      </BrandProvider>,
    );
    expect(screen.queryByTestId('topbar-audit')).toBeNull();
    // One organization: no switcher in the sidebar.
    expect(screen.queryByTestId('sidebar-switch')).toBeNull();
  });
});
