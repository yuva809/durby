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
const area = (n: number, name: string, sortOrder: number, tableCount: number) => ({
  id: id(50 + n),
  locationId: LOCATION.id,
  name,
  sortOrder,
  tableCount,
});
const DINING = area(1, 'Dining room', 0, 2);
const TERRACE = area(2, 'Terrace', 1, 1);
const GARDEN = area(3, 'Garden', 2, 0);
const table = (n: number, name: string, extra: object = {}) => ({
  id: id(10 + n),
  locationId: LOCATION.id,
  name,
  seats: 4,
  areaId: DINING.id,
  area: 'Dining room',
  shape: 'square',
  color: 'neutral',
  sortOrder: 0,
  archivedAt: null,
  ...extra,
});
const T1 = table(1, 'T1');
const T2 = table(2, 'T2');
const TERRACE_1 = table(3, 'Terrace 1', {
  areaId: TERRACE.id,
  area: 'Terrace',
  shape: 'round',
  color: 'teal',
  seats: 2,
});
const OLD = table(4, 'Old 1', { archivedAt: '2026-10-01T10:00:00.000Z' });
const LOOSE = table(5, 'Bar 1', { areaId: null, area: null });

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
  'GET /api/v1/pos/tables': () => Response.json({ data: [T1, T2, TERRACE_1, OLD, LOOSE] }),
  'GET /api/v1/pos/areas': () => Response.json({ data: [DINING, TERRACE, GARDEN] }),
  'GET /api/v1/pos/floor': () =>
    Response.json({
      data: [
        { ...T1, order: ORDER },
        { ...T2, order: null },
        { ...TERRACE_1, order: null },
        { ...LOOSE, order: null },
      ],
    }),
};

const names = () => screen.getAllByTestId('table-card').map((c) => c.dataset.name);
const sectionTitles = () =>
  screen.getAllByTestId('table-area').map((a) => a.querySelector('h2')?.textContent);
const section = (name: string) =>
  screen
    .getAllByTestId('table-area')
    .find((a) => a.querySelector('h2')?.textContent?.startsWith(name))!;

describe('TablesPage', () => {
  it('shows "no access" without pos.tables.read', () => {
    mockState.session = sessionFixture({ activePermissions: ['catalog.products.read'] });
    render(<TablesPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it('shows the KPIs, the areas in order (also empty ones) and each table with status and look', async () => {
    signedInAs('manager');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await waitFor(() =>
      expect(screen.getByTestId('table-kpis').textContent).toBe(
        'Tables in service4Available3Occupied1Out of service1',
      ),
    );
    expect(sectionTitles()).toEqual([
      'Dining room2 tables',
      'Terrace1 table',
      'Garden0 tables',
      'No area1 table',
    ]);
    expect(within(section('Garden')).getByText('No tables in this area yet.')).toBeTruthy();
    const t1 = screen.getAllByTestId('table-card')[0]!;
    expect(t1.dataset.status).toBe('occupied');
    expect(within(t1).getByText('6 items · open 18 h 11 min')).toBeTruthy();
    const terrace = screen
      .getAllByTestId('table-card')
      .find((c) => c.dataset.name === 'Terrace 1')!;
    expect(terrace.querySelector('svg')?.dataset).toMatchObject({ shape: 'round', color: 'teal' });
  });

  it('searches by table or area name and shows out-of-service tables on request', async () => {
    signedInAs('manager');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.type(screen.getByLabelText('Search tables or areas'), 'terr');
    expect(names()).toEqual(['Terrace 1']);
    await userEvent.clear(screen.getByLabelText('Search tables or areas'));
    await userEvent.type(screen.getByLabelText('Search tables or areas'), 'garden');
    expect(sectionTitles()).toEqual(['Garden0 tables']);
    await userEvent.clear(screen.getByLabelText('Search tables or areas'));
    await userEvent.click(screen.getByTestId('toggle-out-of-service'));
    expect(names()).toEqual(['T1', 'T2', 'Old 1', 'Terrace 1', 'Bar 1']);
  });

  it('is read-only for Staff, without order status', async () => {
    signedInAs('staff');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    expect(screen.queryByTestId('table-create')).toBeNull();
    expect(screen.queryByTestId('area-create')).toBeNull();
    expect(screen.queryAllByTestId('area-actions')).toEqual([]);
    expect(screen.getByTestId('table-kpis').textContent).toBe('Tables in service4Out of service1');
    expect(
      mockState.store.apiFetch.mock.calls.some(([path]) =>
        String(path).startsWith('/api/v1/pos/floor'),
      ),
    ).toBe(false);
  });

  it('adds an area', async () => {
    signedInAs('manager');
    const writes = api({
      ...answers,
      'POST /api/v1/pos/areas': () => Response.json(area(4, 'Bar', 3, 0), { status: 201 }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(screen.getByTestId('area-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Enter a name.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Name'), ' Bar ');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toEqual([
      { method: 'POST', path: '/api/v1/pos/areas', body: { locationId: LOCATION.id, name: 'Bar' } },
    ]);
  });

  it('renames an area and deletes only an empty one', async () => {
    signedInAs('manager');
    const writes = api({
      ...answers,
      [`PATCH /api/v1/pos/areas/${TERRACE.id}`]: () => Response.json({ ...TERRACE, name: 'Patio' }),
      [`DELETE /api/v1/pos/areas/${GARDEN.id}`]: () => new Response(null, { status: 204 }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');

    await userEvent.click(
      within(section('Terrace')).getByRole('button', { name: 'Rename Terrace' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Patio');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // An area with tables can't be deleted; the button says why.
    const blocked = within(section('Terrace')).getByTestId('area-delete');
    expect(blocked.hasAttribute('disabled')).toBe(true);
    expect(blocked.getAttribute('title')).toBe('Only an area without tables can be deleted.');

    await userEvent.click(within(section('Garden')).getByRole('button', { name: 'Delete Garden' }));
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      { method: 'PATCH', path: `/api/v1/pos/areas/${TERRACE.id}`, body: { name: 'Patio' } },
      { method: 'DELETE', path: `/api/v1/pos/areas/${GARDEN.id}`, body: undefined },
    ]);
  });

  it("adds a table from an area's section, with its look", async () => {
    signedInAs('manager');
    const writes = api({
      ...answers,
      'POST /api/v1/pos/tables': () => Response.json(table(6, 'T6'), { status: 201 }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(
      within(section('Terrace')).getByRole('button', { name: 'Add a table to Terrace' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Area').value).toBe(TERRACE.id);
    await userEvent.type(within(dialog).getByLabelText('Name'), 'T6');
    await userEvent.clear(within(dialog).getByLabelText('Seats'));
    await userEvent.type(within(dialog).getByLabelText('Seats'), '0');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Enter 1 to 100 seats.')).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Seats'));
    await userEvent.type(within(dialog).getByLabelText('Seats'), '6');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Teal' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Long' }));
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/pos/tables',
        body: {
          locationId: LOCATION.id,
          name: 'T6',
          seats: 6,
          areaId: TERRACE.id,
          shape: 'long',
          color: 'teal',
        },
      },
    ]);
  });

  it('moves a table to another area or to none', async () => {
    signedInAs('manager');
    const writes = api({
      ...answers,
      [`PATCH /api/v1/pos/tables/${T2.id}`]: () => Response.json({ ...T2, areaId: null }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(screen.getByRole('button', { name: 'Edit T2' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Area'), '');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      path: `/api/v1/pos/tables/${T2.id}`,
      body: { areaId: null },
    });
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
