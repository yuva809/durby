// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { DEFAULT_THEME, type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../app/manifest';
import type { PushState } from '../../lib/account/push';
import { appIconLetter } from '../../lib/app-icon';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { NotificationSettings } from '../account/notification-settings';
import { NotificationsBell } from '../shell/notifications-bell';
import { DailyReportOffer } from './daily-report-offer';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'app.partner.test' })),
}));
const theme = vi.hoisted(() => ({ fetchTheme: vi.fn() }));
vi.mock('../../lib/theme', () => theme);
const push = vi.hoisted(() => ({
  state: 'off',
  turnPushOn: vi.fn(),
  turnPushOff: vi.fn(),
}));
vi.mock('../../lib/account/push', () => ({
  loadPushConfig: () => Promise.resolve({ ok: true, data: { publicKey: 'KEY' } }),
  pushState: () => Promise.resolve(push.state),
  turnPushOn: push.turnPushOn,
  turnPushOff: push.turnPushOff,
}));

const ROLE = '0190a000-0000-7000-8000-000000000a01';

const signedIn = (role: SystemRole = 'owner', activeFeatures = ['reports', 'pos']) => {
  mockState.session = sessionFixture({
    activeRole: { id: ROLE, systemKey: role, name: null },
    activeFeatures,
    activePermissions: [...systemRolePermissions(role)],
  });
  return mockState.session;
};

beforeEach(() => {
  resetMocks();
  push.state = 'off' satisfies PushState;
  push.turnPushOn.mockReset().mockResolvedValue('on');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the offer on the overview', () => {
  it('turns push on from the tap and says that it is on', async () => {
    render(<DailyReportOffer session={signedIn()} />);
    const offer = await screen.findByTestId('daily-report-offer');
    expect(offer.textContent).toContain("Get yesterday's sales on this device every morning.");
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(push.turnPushOn).toHaveBeenCalledWith(mockState.store, 'KEY');
    await waitFor(() => expect(offer.textContent).toContain('On: the updates you tick'));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says when the browser did not turn it on, and can be tried again', async () => {
    push.turnPushOn.mockRejectedValueOnce(new Error('push service error'));
    render(<DailyReportOffer session={signedIn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    const offer = screen.getByTestId('daily-report-offer');
    await waitFor(() => expect(offer.textContent).toContain('The browser did not turn it on'));
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(offer.textContent).toContain('On: the updates you tick'));
  });

  it('says when the browser blocks it', async () => {
    push.turnPushOn.mockResolvedValue('blocked');
    render(<DailyReportOffer session={signedIn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(screen.getByTestId('daily-report-offer').textContent).toContain('blocked'),
    );
  });

  it('shows nothing when on, or where it can not work', async () => {
    for (const state of ['on', 'unavailable', 'blocked', 'unsupported']) {
      push.state = state;
      render(<DailyReportOffer session={signedIn()} />);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(screen.queryByTestId('daily-report-offer')).toBeNull();
      cleanup();
    }
  });

  it('tells iPhones to add the app to the home screen', async () => {
    push.state = 'unsupported';
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS)');
    render(<DailyReportOffer session={signedIn()} />);
    expect((await screen.findByTestId('daily-report-offer')).textContent).toContain(
      'add the app to your home screen first',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is for owners with reports and the till', async () => {
    for (const session of [
      signedIn('admin'),
      signedIn('manager'),
      signedIn('owner', ['reports', 'inventory']),
      signedIn('owner', ['pos']),
    ]) {
      render(<DailyReportOffer session={session} />);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(screen.queryByTestId('daily-report-offer')).toBeNull();
      cleanup();
    }
  });
});

describe('the choice', () => {
  const PREFS = [
    { kind: 'low_stock', email: false, push: false },
    { kind: 'daily_sales', email: false, push: true },
  ];
  const names = async () =>
    (await screen.findAllByTestId('pref-row')).map((row) => row.textContent);

  it('is listed for owners, pushed by default, with a word about the lock screen', async () => {
    mockState.store.apiFetch.mockImplementation(() =>
      Promise.resolve(Response.json({ data: PREFS })),
    );
    signedIn();
    render(<NotificationSettings />);
    expect(await names()).toEqual([
      'An item drops to its reorder level',
      'Daily sales report (every morning)',
    ]);
    expect(screen.getByTestId('pref-daily_sales-push').getAttribute('data-state')).toBe('checked');
    expect(screen.getByTestId('daily-report-note').textContent).toContain('lock screen');
  });

  it('is not listed for anyone else', async () => {
    mockState.store.apiFetch.mockImplementation(() =>
      Promise.resolve(Response.json({ data: PREFS })),
    );
    signedIn('manager');
    render(<NotificationSettings />);
    expect(await names()).toEqual(['An item drops to its reorder level']);
    expect(screen.queryByTestId('daily-report-note')).toBeNull();
  });
});

describe('the bell', () => {
  it('shows both lines and leads to the overview', async () => {
    signedIn();
    const notification = {
      id: '0190a000-0000-7000-8000-000000000b01',
      kind: 'daily_sales',
      entityType: 'daily_report',
      entityId: '0190a000-0000-7000-8000-000000000b02',
      params: {
        day: '2026-11-23',
        currency: 'EUR',
        gross: '1240.00',
        orders: '52',
        average: '23.85',
        percent: '8.0',
      },
      readAt: null,
      createdAt: '2026-11-24T07:00:00.000Z',
    };
    mockState.store.apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        Response.json(
          path.includes('/notifications')
            ? path.endsWith('/read')
              ? { ...notification, readAt: notification.createdAt }
              : { data: [notification], unread: 1 }
            : { total: 0, items: [] },
        ),
      ),
    );
    render(<NotificationsBell />);
    await userEvent.click(await screen.findByRole('button', { name: /1/ }));
    const updates = screen.queryByRole('tab', { name: /Updates/ });
    if (updates) await userEvent.click(updates);
    const item = await screen.findByTestId('update-item');
    expect(item.textContent).toContain('Mon, Nov 23: €1,240.00 sales');
    expect(item.textContent).toContain('Orders: 52, average €23.85. +8.0 % against a normal day.');
    await userEvent.click(item);
    await waitFor(() => expect(mockState.router.push).toHaveBeenCalledWith('/'));
  });
});

describe('on the phone', () => {
  it('the manifest carries the partner’s name and colors', async () => {
    theme.fetchTheme.mockResolvedValue({ ...DEFAULT_THEME, productName: 'AsiaMight' });
    const result = await manifest();
    expect(theme.fetchTheme).toHaveBeenCalledWith('app.partner.test');
    expect(result).toMatchObject({
      name: 'AsiaMight',
      display: 'standalone',
      start_url: '/',
      background_color: DEFAULT_THEME.tokens.background,
    });
    // One app for owners and waiters: the till is a shortcut (ADR 0072).
    expect(result.shortcuts).toEqual([{ name: 'Service', url: '/service' }]);
    expect(result.icons?.map((i) => i.src)).toEqual(['/app-icon/192', '/app-icon/512']);
  });

  it('puts a plain first letter on the icon', () => {
    expect(['durby', ' 9 Dragons', '東京', ''].map(appIconLetter)).toEqual(['D', '9', '', '']);
  });

  it('the service worker shows the second line, and none without it', () => {
    const shown: unknown[][] = [];
    const handlers: Record<string, (event: unknown) => void> = {};
    runInNewContext(readFileSync(join(__dirname, '../../public/sw.js'), 'utf8'), {
      URL,
      self: {
        addEventListener: (name: string, fn: (event: unknown) => void) => (handlers[name] = fn),
        registration: { showNotification: (...args: unknown[]) => shown.push(args) },
      },
    });
    const receive = (message: object) =>
      handlers.push!({ data: { json: () => message }, waitUntil: () => undefined });
    receive({ title: 'A', body: 'B', url: '/' });
    receive({ title: 'A', url: '/x' });
    expect(JSON.parse(JSON.stringify(shown))).toEqual([
      ['A', { body: 'B', data: { url: '/' }, tag: '/' }],
      ['A', { data: { url: '/x' }, tag: '/x' }],
    ]);
  });
});
