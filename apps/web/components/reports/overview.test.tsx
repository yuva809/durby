// @vitest-environment jsdom
import { type OverviewResponse, type SystemRole, systemRolePermissions } from '@durby/shared';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from '../../app/(app)/page';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());
const brand = vi.hoisted(() => ({ layout: 'default' }));
vi.mock('../theme-provider', () => ({ useNavLayout: () => brand.layout }));

const id = (n: number) => `0190a000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`;

const today = (gross: string, changePercent: string | null) => ({
  gross,
  items: 2,
  orders: 2,
  averageOrder: '20.00',
  openTables: 1,
  changePercent,
});

const OVERVIEW: OverviewResponse = {
  currency: 'EUR',
  asOf: '2026-11-24T17:00:00.000Z',
  hasData: true,
  total: {
    today: { ...today('45.00', '125.0'), averageOrder: null, openTables: 3 },
    yesterday: {
      gross: '72.00',
      orders: 4,
      normal: { gross: '67.50', compared: '67.00', difference: '-0.50', changePercent: '-0.7' },
      leftOut: 1,
    },
  },
  locations: [
    {
      locationId: id(1),
      name: 'Mitte',
      today: today('40.00', '0.0'),
      yesterday: {
        day: '2026-11-23',
        gross: '57.00',
        orders: 2,
        normal: { gross: '37.50', days: 4, difference: '19.50', changePercent: '52.0' },
      },
    },
    {
      locationId: id(2),
      name: 'Nord',
      today: today('5.00', null),
      yesterday: {
        day: '2026-11-23',
        gross: '10.00',
        orders: 1,
        normal: { gross: '0.00', days: 2, difference: '10.00', changePercent: null },
      },
    },
    {
      locationId: id(3),
      name: 'Ost',
      today: today('0.00', null),
      yesterday: { day: '2026-11-22', gross: '5.00', orders: 1, normal: null },
    },
  ],
};

let answer: () => Response;
let settings: { key: string; value: unknown }[];
const calls: string[] = [];
const overviewCalls = () => calls.filter((c) => c === '/api/v1/reports/overview').length;

const signedIn = (role: SystemRole = 'owner', activeFeatures: string[] = ['reports', 'pos']) => {
  mockState.session = sessionFixture({
    activeFeatures,
    activePermissions: [...systemRolePermissions(role)],
  });
};

beforeEach(() => {
  resetMocks();
  brand.layout = 'default';
  calls.length = 0;
  answer = () => Response.json(OVERVIEW);
  settings = [
    { key: 'timezone', value: 'Europe/Berlin' },
    { key: 'locale', value: 'en' },
  ];
  mockState.store.apiFetch.mockImplementation((input: string) => {
    const path = new URL(input, 'http://web.test').pathname;
    calls.push(path);
    if (path === '/api/v1/reports/overview') return Promise.resolve(answer());
    if (path === '/api/v1/settings') {
      return Promise.resolve(
        Response.json({
          data: settings.map((s) => ({ ...s, source: 'default', dataBound: false })),
        }),
      );
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('owner overview', () => {
  it('shows the group today, and yesterday against a normal day', async () => {
    signedIn();
    render(<HomePage />);
    const card = await screen.findByTestId('overview-today');
    expect(card.textContent).toContain('€45.00');
    expect(card.textContent).toContain('Open tables3');
    expect(card.textContent).toContain('Average orderNone');
    expect(screen.getByTestId('overview-today-change').textContent).toBe(
      '+125.0 % against the same weekday last week, up to this time',
    );
    expect(screen.getByTestId('overview-yesterday').textContent).toContain('€72.00');
    expect(screen.getByTestId('overview-yesterday-change').textContent).toBe(
      '-0.7 % (-€0.50) against a normal day of €67.50',
    );
    expect(screen.getByTestId('overview-left-out').textContent).toBe(
      'Locations without a comparison: 1. The others had €67.00 yesterday.',
    );
    expect(screen.getByTestId('overview-as-of').textContent).toMatch(/^As of 0?6:00/);
    expect(screen.getByTestId('overview').textContent).toContain('not accounting revenue');
  });

  it('lists each location with its comparison, as rows and as cards', async () => {
    signedIn();
    render(<HomePage />);
    const rows = within(await screen.findByTestId('overview-locations')).getAllByRole('row');
    const none = 'No comparison yet';
    expect(rows.slice(1).map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      [
        'Mitte',
        '€40.00',
        '0.0 %',
        '2',
        '€20.00',
        '1',
        '€57.00Mon, Nov 23',
        '€37.50From 4 of 4 days',
        '+€19.50+52.0 %',
      ],
      [
        'Nord',
        '€5.00',
        none,
        '2',
        '€20.00',
        '1',
        '€10.00Mon, Nov 23',
        '€0.00From 2 of 4 days',
        '+€10.00',
      ],
      ['Ost', '€0.00', none, '2', '€20.00', '1', '€5.00Sun, Nov 22', none, none],
    ]);
    const cards = within(screen.getByTestId('overview-cards')).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(cards[1]!.textContent).toContain('+€10.00 against a normal day of €0.00');
    expect(cards[2]!.textContent).toContain(none);
  });

  it('with one location shows its days in the card, and no list', async () => {
    signedIn();
    const first = OVERVIEW.locations[0]!;
    const { gross, difference, changePercent } = first.yesterday.normal!;
    answer = () =>
      Response.json({
        ...OVERVIEW,
        total: {
          today: first.today,
          yesterday: {
            gross: '57.00',
            orders: 2,
            normal: { gross, difference, changePercent, compared: '57.00' },
            leftOut: 0,
          },
        },
        locations: [first],
      });
    render(<HomePage />);
    const card = await screen.findByTestId('overview-yesterday');
    expect(card.textContent).toContain('Mon, Nov 23');
    expect(card.textContent).toContain('From 4 of 4 days');
    expect(screen.queryByTestId('overview-locations')).toBeNull();
    expect(screen.queryByTestId('overview-left-out')).toBeNull();
  });

  it('says when there is no data or no location', async () => {
    signedIn();
    const empty = { ...OVERVIEW, hasData: false };
    const none = { ...today('0.00', null), openTables: 0 };
    answer = () => Response.json({ ...empty, total: { ...empty.total, today: none } });
    render(<HomePage />);
    expect((await screen.findByTestId('overview-no-data')).textContent).toContain(
      'once the report data has been built',
    );
    cleanup();
    answer = () => Response.json({ ...empty, locations: [] });
    render(<HomePage />);
    expect(await screen.findByText('There are no active locations to show.')).toBeTruthy();
  });

  it('formats numbers in the language of the organization', async () => {
    signedIn();
    settings = [{ key: 'locale', value: 'de' }];
    render(<HomePage />);
    expect((await screen.findByTestId('overview-today-change')).textContent).toContain('+125,0 %');
  });
});

describe('refresh', () => {
  const show = (state: 'visible' | 'hidden') => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
  };
  const minute = () => act(() => vi.advanceTimersByTimeAsync(60_000));

  it('reloads every minute while visible, and at once when it is again', async () => {
    vi.useFakeTimers();
    signedIn();
    render(<HomePage />);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(overviewCalls()).toBe(1);
    await minute();
    expect(overviewCalls()).toBe(2);
    show('hidden');
    await minute();
    await minute();
    expect(overviewCalls()).toBe(2);
    show('visible');
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(overviewCalls()).toBe(3);
  });

  it('keeps the last figures through a temporary failure and says so; a refusal is shown', async () => {
    vi.useFakeTimers();
    signedIn();
    render(<HomePage />);
    await act(() => vi.advanceTimersByTimeAsync(10));
    answer = () => new Response('gateway', { status: 502 });
    await minute();
    expect(screen.getByTestId('overview-today').textContent).toContain('€45.00');
    expect(screen.getByText(/^Could not refresh\. These are the figures of/)).toBeTruthy();
    answer = () => Response.json(OVERVIEW);
    await minute();
    expect(screen.queryByText(/^Could not refresh/)).toBeNull();
    answer = () => Response.json({ code: 'rbac.forbidden', message: 'x' }, { status: 403 });
    await minute();
    expect(screen.queryByTestId('overview-today')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('the home page otherwise', () => {
  it('greets people without the key or the modules, and loads no figures', async () => {
    for (const [role, features] of [
      ['waiter', ['reports', 'pos']],
      ['owner', ['reports', 'inventory']],
      ['owner', ['pos']],
    ] as const) {
      signedIn(role, [...features]);
      render(<HomePage />);
      expect(await screen.findByText(/^Welcome to/)).toBeTruthy();
      cleanup();
    }
    expect(overviewCalls()).toBe(0);
  });

  it('leads waiters on to Service in the installed app, and only there (ADR 0072)', async () => {
    const standalone = (matches: boolean) =>
      vi.stubGlobal('matchMedia', () => ({
        matches,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
    try {
      standalone(true);
      signedIn('waiter');
      render(<HomePage />);
      await waitFor(() => expect(mockState.router.replace).toHaveBeenCalledWith('/service'));
      cleanup();
      mockState.router.replace.mockReset();
      // Owners keep the Overview, where push is turned on; staff don't take orders; a browser stays.
      signedIn('owner');
      render(<HomePage />);
      await screen.findByTestId('overview-today');
      cleanup();
      signedIn('staff');
      render(<HomePage />);
      await screen.findByText(/^Welcome to/);
      cleanup();
      signedIn('waiter', []);
      render(<HomePage />);
      await screen.findByText(/^Welcome to/);
      cleanup();
      standalone(false);
      signedIn('waiter');
      render(<HomePage />);
      await screen.findByText(/^Welcome to/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mockState.router.replace).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still leads to the start page, without loading figures', async () => {
    signedIn();
    settings = [{ key: 'startPage', value: 'inventory' }];
    render(<HomePage />);
    await waitFor(() => expect(mockState.router.replace).toHaveBeenCalledWith('/inventory'));
    expect(overviewCalls()).toBe(0);
  });
});
