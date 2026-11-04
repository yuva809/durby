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
  menuCode: `code${String(n).padStart(20, '0')}`,
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
  covers: null,
  itemCount: 6,
  gross: '56.00',
  readyCount: 0,
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
const tabs = () => screen.getAllByTestId('area-tab').map((t) => t.textContent);
const tab = (name: string) =>
  screen.getAllByTestId('area-tab').find((t) => t.dataset.name === name)!;

describe('TablesPage', () => {
  it('shows "no access" without pos.tables.read', () => {
    mockState.session = sessionFixture({ activePermissions: ['catalog.products.read'] });
    render(<TablesPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it('shows the summary, area tabs (also empty areas) and each table with status and look', async () => {
    signedInAs('manager');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await waitFor(() =>
      expect(screen.getByTestId('table-kpis').textContent).toBe(
        'Tables in service4Available3Occupied1Out of service1',
      ),
    );
    expect(tabs()).toEqual(['All4', 'Dining room2', 'Terrace1', 'Garden0', 'No area1']);
    expect(names()).toEqual(['T1', 'T2', 'Terrace 1', 'Bar 1']);
    const t1 = screen.getAllByTestId('table-card')[0]!;
    expect(t1.dataset.status).toBe('occupied');
    expect(within(t1).getByText('6 items · open 18 h 11 min')).toBeTruthy();
    const terrace = screen
      .getAllByTestId('table-card')
      .find((c) => c.dataset.name === 'Terrace 1')!;
    expect(terrace.querySelector('svg')?.dataset).toMatchObject({ shape: 'round', color: 'teal' });
  });

  it('filters by area tab, by search, and shows out-of-service tables on request', async () => {
    signedInAs('manager');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(tab('Terrace'));
    expect(names()).toEqual(['Terrace 1']);
    await userEvent.click(tab('Garden'));
    expect(screen.getByText('No tables in this area yet.')).toBeTruthy();
    await userEvent.click(tab('All'));
    await userEvent.type(screen.getByLabelText('Search tables or areas'), 'terr');
    expect(names()).toEqual(['Terrace 1']);
    await userEvent.clear(screen.getByLabelText('Search tables or areas'));
    await userEvent.click(screen.getByTestId('toggle-out-of-service'));
    expect(names()).toEqual(['T1', 'T2', 'Terrace 1', 'Old 1', 'Bar 1']);
  });

  it('is read-only for Staff, without order status', async () => {
    signedInAs('staff');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    expect(screen.queryByTestId('table-create')).toBeNull();
    expect(screen.queryByTestId('area-create')).toBeNull();
    expect(screen.queryByTestId('table-menu')).toBeNull();
    await userEvent.click(tab('Terrace'));
    expect(screen.queryByTestId('area-actions')).toBeNull();
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

  it('renames the selected area and deletes only an empty one', async () => {
    signedInAs('manager');
    const writes = api({
      ...answers,
      [`PATCH /api/v1/pos/areas/${TERRACE.id}`]: () => Response.json({ ...TERRACE, name: 'Patio' }),
      [`DELETE /api/v1/pos/areas/${GARDEN.id}`]: () => new Response(null, { status: 204 }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    expect(screen.queryByTestId('area-actions')).toBeNull();

    await userEvent.click(tab('Terrace'));
    const tools = screen.getByTestId('area-actions');
    await userEvent.click(within(tools).getByRole('button', { name: 'Rename Terrace' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Patio');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // An area with tables can't be deleted; the button says why.
    const blocked = within(screen.getByTestId('area-actions')).getByTestId('area-delete');
    expect(blocked.hasAttribute('disabled')).toBe(true);
    expect(blocked.getAttribute('title')).toBe('Only an area without tables can be deleted.');

    await userEvent.click(tab('Garden'));
    await userEvent.click(
      within(screen.getByTestId('area-actions')).getByRole('button', { name: 'Delete Garden' }),
    );
    const confirm = await screen.findByRole('alertdialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      { method: 'PATCH', path: `/api/v1/pos/areas/${TERRACE.id}`, body: { name: 'Patio' } },
      { method: 'DELETE', path: `/api/v1/pos/areas/${GARDEN.id}`, body: undefined },
    ]);
  });

  it('adds a table in the selected area, with its look', async () => {
    signedInAs('manager');
    const writes = api({
      ...answers,
      'POST /api/v1/pos/tables': () => Response.json(table(6, 'T6'), { status: 201 }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(tab('Terrace'));
    await userEvent.click(screen.getByTestId('table-create'));
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

  it('moves a table to no area', async () => {
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

  it('takes a table out of service and back from its menu', async () => {
    signedInAs('owner');
    const writes = api({
      ...answers,
      [`PATCH /api/v1/pos/tables/${T2.id}`]: () =>
        Response.json({ ...T2, archivedAt: '2026-10-28T12:00:00.000Z' }),
      [`PATCH /api/v1/pos/tables/${OLD.id}`]: () => Response.json({ ...OLD, archivedAt: null }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(screen.getByRole('button', { name: 'More for T2' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Take T2 out of service' }));
    await userEvent.click(screen.getByTestId('toggle-out-of-service'));
    await userEvent.click(screen.getByRole('button', { name: 'More for Old 1' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Put Old 1 back in service' }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual([
      { method: 'PATCH', path: `/api/v1/pos/tables/${T2.id}`, body: { archived: true } },
      { method: 'PATCH', path: `/api/v1/pos/tables/${OLD.id}`, body: { archived: false } },
    ]);
  });
  // ADR 0026: the table's QR code for guests, printed on a card; managers renew it.
  it('shows a table QR code with its menu link; a new code replaces it', async () => {
    signedInAs('manager');
    const renewed = { ...T1, menuCode: 'NEWCODE0000000000000000x' };
    const writes = api({
      ...answers,
      [`POST /api/v1/pos/tables/${T1.id}/menu-token`]: () =>
        Response.json(renewed, { status: 201 }),
    });
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    const t1 = screen.getAllByTestId('table-card')[0]!;
    await userEvent.click(within(t1).getByTestId('table-qr'));
    const dialog = await screen.findByRole('dialog');
    const org = '0190a000-0000-7000-8000-0000000000a1';
    expect(within(dialog).getByTestId('qr-url').textContent).toBe(
      `${window.location.origin}/menu/${org}.${T1.menuCode}`,
    );
    const image = await within(dialog).findByTestId('qr-image');
    expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    await userEvent.click(within(dialog).getByTestId('qr-renew'));
    await waitFor(() =>
      expect(within(dialog).getByTestId('qr-url').textContent).toContain(renewed.menuCode),
    );
    expect(writes).toEqual([
      { method: 'POST', path: `/api/v1/pos/tables/${T1.id}/menu-token`, body: {} },
    ]);
  });

  it('lets Staff see and print the QR code but not renew it', async () => {
    signedInAs('staff');
    api(answers);
    render(<TablesPage />);
    await screen.findAllByTestId('table-card');
    await userEvent.click(within(screen.getAllByTestId('table-card')[0]!).getByTestId('table-qr'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('qr-image');
    expect(within(dialog).queryByTestId('qr-renew')).toBeNull();
    expect(within(dialog).getByTestId('qr-print')).toBeTruthy();
  });
});
