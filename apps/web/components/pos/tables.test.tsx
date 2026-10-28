// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { TablesPage } from './tables-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000006${String(n).padStart(2, '0')}`;
const LOCATION = { id: id(1), name: 'Main street', brandId: id(2) };
const table = (n: number, name: string, extra: object = {}) => ({
  id: id(10 + n),
  locationId: LOCATION.id,
  name,
  seats: 4,
  area: null,
  shape: 'square',
  color: 'neutral',
  sortOrder: 0,
  archivedAt: null,
  ...extra,
});
const T1 = table(1, 'T1');
const T2 = table(2, 'T2');
const TERRACE = table(3, 'Terrace 1', { area: 'Terrace', shape: 'round', color: 'teal', seats: 2 });
const OLD = table(4, 'Old 1', { archivedAt: '2026-10-01T10:00:00.000Z' });

const ORDER = {
  id: id(40),
  number: 'ORD-2026-000001',
  tableId: T1.id,
  tableName: 'T1',
  locationId: LOCATION.id,
  status: 'open',
  openedAt: new Date(Date.now() - (18 * 60 + 11) * 60_000).toISOString(),
  closedAt: null,
  itemCount: 6,
  gross: '56.00',
};

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog', 'pos'],
  });
}

function api(answers: Record<string, () => Response>) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/\?.*$/, '');
    if (method !== 'GET') {
      writes.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    }
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(answer ? answer() : Response.json({ data: [] }));
  });
  return writes;
}

const answers = {
  'GET /api/v1/locations': () => Response.json({ data: [LOCATION] }),
  'GET /api/v1/pos/tables': () => Response.json({ data: [T1, T2, TERRACE, OLD] }),
  'GET /api/v1/pos/floor': () =>
    Response.json({
      data: [
        { ...T1, order: ORDER },
        { ...T2, order: null },
        { ...TERRACE, order: null },
      ],
    }),
};

const names = () => screen.getAllByTestId('table-card').map((c) => c.dataset.name);

describe('TablesPage', () => {
  it('shows "no access" without pos.tables.read', () => {
    mockState.session = sessionFixture({ activePermissions: ['catalog.products.read'] });
    render(<TablesPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it('shows the KPIs, area sections and each table with its status and look', async () => {
    signedInAs('manager');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await waitFor(() =>
      expect(screen.getByTestId('table-kpis').textContent).toBe(
        'Tables in service3Available2Occupied1Out of service1',
      ),
    );
    expect(names()).toEqual(['T1', 'T2', 'Terrace 1']);
    expect(
      screen.getAllByTestId('table-area').map((a) => a.querySelector('h2')?.textContent),
    ).toEqual(['Dining room2 tables', 'Terrace1 table']);
    const t1 = screen.getAllByTestId('table-card')[0]!;
    expect(t1.dataset.status).toBe('occupied');
    expect(within(t1).getByText('6 items · open 18 h 11 min')).toBeTruthy();
    const terrace = screen.getAllByTestId('table-card')[2]!;
    expect(terrace.querySelector('svg')?.dataset).toMatchObject({ shape: 'round', color: 'teal' });
    expect(within(terrace).getByText('No open order')).toBeTruthy();
  });

  it('searches by name or area and shows out-of-service tables on request', async () => {
    signedInAs('manager');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.type(screen.getByLabelText('Search tables or areas'), 'terr');
    expect(names()).toEqual(['Terrace 1']);
    await userEvent.clear(screen.getByLabelText('Search tables or areas'));
    await userEvent.click(screen.getByTestId('toggle-out-of-service'));
    expect(names()).toEqual(['T1', 'T2', 'Old 1', 'Terrace 1']);
    expect(screen.getAllByTestId('table-card')[2]!.dataset.status).toBe('outOfService');
  });

  it('is read-only for Staff, without order status', async () => {
    signedInAs('staff');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    expect(screen.queryByTestId('table-create')).toBeNull();
    expect(screen.queryByTestId('table-edit')).toBeNull();
    expect(screen.getByTestId('table-kpis').textContent).toBe('Tables in service3Out of service1');
    expect(
      mockState.store.apiFetch.mock.calls.some(([path]) =>
        String(path).startsWith('/api/v1/pos/floor'),
      ),
    ).toBe(false);
  });

  it('creates a table with its look', async () => {
    signedInAs('manager');
    const writes = api({
      ...answers,
      'POST /api/v1/pos/tables': () => Response.json(table(5, 'T5'), { status: 201 }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(screen.getByTestId('table-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'T5');
    await userEvent.type(within(dialog).getByLabelText('Area'), 'Terrace');
    await userEvent.clear(within(dialog).getByLabelText('Seats'));
    await userEvent.type(within(dialog).getByLabelText('Seats'), '0');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Enter 1 to 100 seats.')).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Seats'));
    await userEvent.type(within(dialog).getByLabelText('Seats'), '6');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Teal' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Long' }));
    expect(within(dialog).getByRole('radio', { name: 'Long' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/pos/tables',
        body: {
          locationId: LOCATION.id,
          name: 'T5',
          seats: 6,
          area: 'Terrace',
          shape: 'long',
          color: 'teal',
        },
      },
    ]);
  });

  it('takes a table out of service and back', async () => {
    signedInAs('owner');
    const writes = api({
      ...answers,
      [`PATCH /api/v1/pos/tables/${T2.id}`]: () =>
        Response.json({ ...T2, archivedAt: '2026-10-28T12:00:00.000Z' }),
      [`PATCH /api/v1/pos/tables/${OLD.id}`]: () => Response.json({ ...OLD, archivedAt: null }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(screen.getByRole('button', { name: 'Take T2 out of service' }));
    await userEvent.click(screen.getByTestId('toggle-out-of-service'));
    await userEvent.click(screen.getByRole('button', { name: 'Put Old 1 back in service' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      { method: 'PATCH', path: `/api/v1/pos/tables/${T2.id}`, body: { archived: true } },
      { method: 'PATCH', path: `/api/v1/pos/tables/${OLD.id}`, body: { archived: false } },
    ]);
  });
});
