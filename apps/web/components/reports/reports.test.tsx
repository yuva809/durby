// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { ReservationsReport } from './reservations-report';
import { SalesReport } from './sales-report';
import { TablesReport } from './tables-report';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

const HERE = '0190a000-0000-7000-8000-000000000701';
const THERE = '0190a000-0000-7000-8000-000000000702';
const id = (n: number) => `0190a000-0000-7000-8000-0000000008${String(n).padStart(2, '0')}`;

const ALL = ['reports', 'pos', 'reservations'];

const signedIn = (role: SystemRole = 'owner', activeFeatures: string[] = ALL) => {
  mockState.session = sessionFixture({
    activeFeatures,
    activePermissions: [...systemRolePermissions(role)],
  });
};

const location = (locationId: string, name: string, extra: object = {}) => ({
  id: locationId,
  name,
  brandId: id(90),
  address: null,
  archivedAt: null,
  isWarehouseSite: false,
  ...extra,
});

const figures = (gross: string, orders = 1) => ({
  gross,
  items: orders,
  orders,
  averageOrder: gross,
});

const SUMMARY = {
  currency: 'EUR',
  cards: [
    { key: 'today', figures: figures('40.00'), compare: figures('20.00'), changePercent: '100.0' },
    {
      key: 'yesterday',
      figures: figures('57.00'),
      compare: figures('60.00'),
      changePercent: '-5.0',
    },
    { key: 'week', figures: figures('97.00'), compare: figures('0.00', 0), changePercent: null },
  ],
  period: { ...figures('139.00', 3), secondRoundOrders: 2, secondRoundRate: '66.7' },
};

const ITEMS = Array.from({ length: 12 }, (_, i) => ({
  productId: id(i),
  name: i === 0 ? '=cmd' : `Dish ${i}`,
  categoryName: 'Food',
  quantity: 20 - i,
  gross: `${100 - i}.50`,
}));

const RESPONSES: Record<string, unknown> = {
  '/api/v1/reports/sales/summary': SUMMARY,
  '/api/v1/reports/sales/hours': {
    currency: 'EUR',
    data: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      gross: hour === 12 ? '80.00' : hour === 19 ? '20.00' : '0.00',
      items: hour === 12 ? 8 : hour === 19 ? 2 : 0,
      orders: hour === 12 ? 4 : hour === 19 ? 1 : 0,
    })),
  },
  '/api/v1/reports/sales/items': { currency: 'EUR', data: ITEMS },
  '/api/v1/reports/sales/categories': {
    currency: 'EUR',
    data: [{ categoryId: id(50), name: 'Food', quantity: 5, gross: '35.00', share: '87.5' }],
  },
  '/api/v1/reports/tables': {
    orders: 3,
    averageMinutes: 65,
    tables: [{ tableId: id(1), locationId: HERE, name: 'T1', orders: 3, averageMinutes: 65 }],
    open: [
      {
        tableId: id(2),
        locationId: THERE,
        name: 'F2',
        openedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        covers: null,
      },
    ],
  },
  '/api/v1/reports/reservations': {
    covers: 13,
    walkInCovers: 5,
    kept: 3,
    noShows: 1,
    noShowRate: '25.0',
    turnMinutes: null,
    turnTimes: [
      { min: 1, max: 2, bookings: 2, minutes: 75 },
      { min: 3, max: 4, bookings: 0, minutes: null },
      { min: 5, max: 6, bookings: 0, minutes: null },
      { min: 7, max: null, bookings: 1, minutes: 120 },
    ],
  },
  '/api/v1/locations': {
    data: [
      location(HERE, 'Mitte'),
      location(THERE, 'Nord'),
      location(id(60), 'Depot', { isWarehouseSite: true }),
    ],
  },
  '/api/v1/settings': {
    data: [
      { key: 'timezone', value: 'Europe/Berlin', source: 'default', dataBound: false },
      { key: 'reports.dayStartsAt', value: '04:00', source: 'default', dataBound: false },
      { key: 'locale', value: 'en', source: 'default', dataBound: false },
    ],
  },
};

const requests: URL[] = [];
const reportRequests = () => requests.filter((u) => u.pathname.startsWith('/api/v1/reports'));

beforeEach(() => {
  resetMocks();
  requests.length = 0;
  mockState.pathname = '/reports';
  mockState.store.apiFetch.mockImplementation((input: string) => {
    const url = new URL(input, 'http://web.test');
    requests.push(url);
    return Promise.resolve(Response.json(RESPONSES[url.pathname] ?? { data: [] }));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('sales report', () => {
  it('shows the cards with their comparison, and the period', async () => {
    signedIn();
    render(<SalesReport />);
    const today = await screen.findByTestId('card-today');
    expect(today.textContent).toContain('€40.00');
    expect(screen.getByTestId('card-today-change').textContent).toBe('+100.0 % (then €20.00)');
    expect(screen.getByTestId('card-yesterday-change').textContent).toBe('-5.0 % (then €60.00)');
    expect(screen.getByTestId('card-week-change').textContent).toBe('No comparison yet');
    const rate = screen.getByTestId('figure-sales.secondRoundRate');
    expect(rate.textContent).toContain('66.7 %');
    expect(rate.textContent).toContain('2 of 3 orders');
    expect(document.body.textContent).toContain('not accounting revenue');
  });

  it('names the busiest hour, and any hour it is pointed at or focused', async () => {
    signedIn();
    render(<SalesReport />);
    const readout = await screen.findByTestId('hour-readout');
    expect(readout.textContent).toBe('€80.00 at 12:00, orders: 4, items: 8');
    fireEvent.focus(screen.getByTestId('hour-19'));
    expect(readout.textContent).toBe('€20.00 at 19:00, orders: 1, items: 2');
    fireEvent.mouseEnter(screen.getByTestId('hour-3'));
    expect(readout.textContent).toBe('€0.00 at 03:00, orders: 0, items: 0');
  });

  it('lists ten top and ten least sold items, and exports all of them safely', async () => {
    signedIn();
    render(<SalesReport />);
    const top = await screen.findByTestId('table-reports.items.top');
    const names = (table: HTMLElement) =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.querySelector('td')?.textContent);
    expect(names(top)).toHaveLength(10);
    expect(names(top)[1]).toBe('Dish 1');
    expect(names(screen.getByTestId('table-reports.items.least'))[0]).toBe('Dish 11');

    const blobs: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob);
          return 'blob:x';
        },
        revokeObjectURL: () => undefined,
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await userEvent.click(within(top).getByRole('button', { name: /Export CSV/ }));
    const rows = (await blobs[0]!.text()).trim().split('\r\n');
    expect(rows).toHaveLength(13);
    expect(rows[0]).toContain('Product,Category,Quantity,Sales');
    // Money is a plain decimal, and a name is never a formula.
    expect(rows[1]).toBe("'=cmd,Food,20,100.50");
  });

  it('asks for the period and location of the address, and changes the address', async () => {
    signedIn();
    mockState.search = `period=custom&from=2026-01-01&to=2026-01-31&location=${THERE}`;
    render(<SalesReport />);
    await screen.findByTestId('card-today');
    expect(Object.fromEntries(reportRequests()[0]!.searchParams)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      locationId: THERE,
    });
    // Warehouse sites are no branch.
    const places = within(screen.getByTestId('report-location')).getAllByRole('option');
    expect(places.map((o) => o.textContent)).toEqual(['All locations', 'Mitte', 'Nord']);
    await userEvent.selectOptions(screen.getByTestId('report-period'), 'today');
    expect(mockState.router.replace).toHaveBeenCalledWith(
      `/reports?period=today&from=2026-01-01&to=2026-01-31&location=${THERE}`,
    );
  });

  it('asks nothing with an unfinished period', async () => {
    signedIn();
    mockState.search = 'period=custom&from=2026-01-01';
    render(<SalesReport />);
    expect(await screen.findByTestId('report-period-invalid')).toBeTruthy();
    expect(reportRequests()).toEqual([]);
  });

  it('shows an error that can be retried', async () => {
    signedIn();
    mockState.store.apiFetch.mockImplementation((input: string) =>
      Promise.resolve(
        input.includes('/reports/')
          ? Response.json({ code: 'reports.location_not_found', message: 'x' }, { status: 404 })
          : Response.json({ data: [] }),
      ),
    );
    render(<SalesReport />);
    expect((await screen.findAllByText('Location not found.')).length).toBeGreaterThan(0);
  });
});

describe('access', () => {
  it('shows nothing without the key or the module, and loads nothing', () => {
    signedIn('waiter');
    render(<SalesReport />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
    cleanup();
    signedIn('owner', ['reports', 'inventory']);
    render(<SalesReport />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
    cleanup();
    signedIn('owner', ['pos']);
    render(<TablesReport />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
    expect(reportRequests()).toEqual([]);
  });

  it('goes to the first tab someone may open', () => {
    signedIn('owner', ['reports', 'reservations']);
    render(<SalesReport />);
    expect(mockState.router.replace).toHaveBeenCalledWith('/reports/reservations');
    expect(reportRequests()).toEqual([]);
  });

  it('keeps the filters in the tabs', async () => {
    signedIn();
    mockState.search = 'period=today';
    render(<SalesReport />);
    const tab = await screen.findByTestId('report-tables');
    expect(tab.getAttribute('href')).toBe('/reports/tables?period=today');
  });
});

describe('tables and reservations', () => {
  it('shows table times and open tables with their location', async () => {
    signedIn();
    mockState.pathname = '/reports/tables';
    render(<TablesReport />);
    expect((await screen.findByTestId('figure-tables.averageMinutes')).textContent).toContain(
      '1 h 5 min',
    );
    expect(screen.getByTestId('figure-tables.open').textContent).toContain('1');
    const open = screen.getByTestId('table-reports.tables.openTitle');
    expect(within(open).getAllByRole('row')[1]!.textContent).toBe('NordF220 min');
  });

  it('shows covers, no-shows and turn times; none where there is none', async () => {
    signedIn();
    mockState.pathname = '/reports/reservations';
    render(<ReservationsReport />);
    expect((await screen.findByTestId('figure-reservations.covers')).textContent).toContain('13');
    expect(screen.getByTestId('figure-reservations.noShowRate').textContent).toContain(
      '1 of 4 bookings',
    );
    expect(screen.getByTestId('figure-reservations.turnMinutes').textContent).toContain('None');
    const rows = within(screen.getByTestId('table-reports.reservations.turnTimes')).getAllByRole(
      'row',
    );
    expect(rows.slice(1).map((r) => r.textContent)).toEqual(['1–221 h 15 min', '7+12 h 0 min']);
  });
});
