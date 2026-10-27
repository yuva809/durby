// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { TablesPage } from '../pos/tables-page';
import { CatalogPage } from './catalog-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(resetMocks);
afterEach(cleanup);

// jsdom has no ResizeObserver; Radix Checkbox measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const id = (n: number) => `0190a000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;
const FOOD = { id: id(1), name: 'Food', sortOrder: 0, archivedAt: null };
const DRINKS = { id: id(2), name: 'Drinks', sortOrder: 1, archivedAt: null };
const product = (n: number, name: string, categoryId: string, price: string, taxRate: string) => ({
  id: id(10 + n),
  categoryId,
  name,
  description: null,
  price,
  taxRate,
  sortOrder: 0,
  archivedAt: null,
});
const SOUP = product(1, 'Soup', FOOD.id, '6.90', '7.00');
const WATER = product(2, 'Water', DRINKS.id, '2.50', '19.00');
const LOCATION = { id: id(50), name: 'Main street', brandId: id(51) };
const TABLE = {
  id: id(60),
  locationId: LOCATION.id,
  name: 'T1',
  seats: 4,
  area: 'Terrace',
  sortOrder: 0,
  archivedAt: null,
};

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog', 'pos'],
  });
}

type Answer = (init: RequestInit | undefined) => Response;

/** Answers by method and path, like the api would; records the writes. */
function api(answers: Record<string, Answer>) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/\?.*$/, '');
    if (method !== 'GET') {
      writes.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    }
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(answer ? answer(init) : Response.json({ data: [] }));
  });
  return writes;
}

const catalogAnswers = {
  'GET /api/v1/catalog/categories': () => Response.json({ data: [FOOD, DRINKS] }),
  'GET /api/v1/catalog/products': () => Response.json({ data: [SOUP, WATER] }),
};

const productNames = async () =>
  (await screen.findAllByTestId('product-row')).map((r) => r.dataset.name);

describe('CatalogPage', () => {
  it('shows "no access" without catalog.products.read and loads nothing', () => {
    mockState.session = sessionFixture({ activePermissions: [] });
    render(<CatalogPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
    expect(mockState.store.apiFetch).not.toHaveBeenCalled();
  });

  it('lists products with decimal strings and filters by category', async () => {
    signedInAs('staff');
    api(catalogAnswers);
    render(<CatalogPage />);
    expect(await productNames()).toEqual(['Soup', 'Water']);
    const soup = (await screen.findAllByTestId('product-row'))[0]!;
    expect(within(soup).getByText('6.90')).toBeTruthy();
    expect(within(soup).getByText('7.00')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Drinks' }));
    expect(await productNames()).toEqual(['Water']);
  });

  it('hides editing from Staff', async () => {
    signedInAs('staff');
    api(catalogAnswers);
    render(<CatalogPage />);
    await productNames();
    expect(screen.queryByTestId('product-create')).toBeNull();
    expect(screen.queryByTestId('category-create')).toBeNull();
    expect(screen.queryByTestId('product-edit')).toBeNull();
  });

  it('creates a product with validated decimal strings', async () => {
    signedInAs('owner');
    const writes = api({
      ...catalogAnswers,
      'POST /api/v1/catalog/products': () =>
        Response.json(product(3, 'Cola', DRINKS.id, '3.20', '19.00'), { status: 201 }),
    });
    render(<CatalogPage />);
    await productNames();
    await userEvent.click(screen.getByTestId('product-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cola');
    await userEvent.selectOptions(within(dialog).getByLabelText('Category'), DRINKS.id);
    await userEvent.type(within(dialog).getByLabelText('Price'), '3,20');
    await userEvent.type(within(dialog).getByLabelText('VAT %'), '19');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Enter an amount like 12.50.')).toBeTruthy();
    expect(writes).toEqual([]);

    await userEvent.clear(within(dialog).getByLabelText('Price'));
    await userEvent.type(within(dialog).getByLabelText('Price'), '3.20');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/catalog/products',
        body: {
          name: 'Cola',
          categoryId: DRINKS.id,
          description: '',
          price: '3.20',
          taxRate: '19',
        },
      },
    ]);
  });

  it('shows the label of an api error in the dialog', async () => {
    signedInAs('owner');
    api({
      ...catalogAnswers,
      'POST /api/v1/catalog/categories': () =>
        Response.json({ code: 'catalog.category_name_taken', message: 'x' }, { status: 409 }),
    });
    render(<CatalogPage />);
    await productNames();
    await userEvent.click(screen.getByTestId('category-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Food');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(
      await within(dialog).findByText('A category with this name already exists.'),
    ).toBeTruthy();
  });
});

describe('TablesPage', () => {
  const tableAnswers = {
    'GET /api/v1/locations': () => Response.json({ data: [LOCATION] }),
    'GET /api/v1/pos/tables': () => Response.json({ data: [TABLE] }),
  };

  it('shows "no access" without pos.tables.read', () => {
    mockState.session = sessionFixture({ activePermissions: ['catalog.products.read'] });
    render(<TablesPage />);
    expect(screen.getByTestId('no-access')).toBeTruthy();
  });

  it("lists the location's tables, read-only for Staff", async () => {
    signedInAs('staff');
    api(tableAnswers);
    render(<TablesPage />);
    const card = await screen.findByTestId('table-card');
    expect(within(card).getByText('T1')).toBeTruthy();
    expect(within(card).getByText('4 seats · Terrace')).toBeTruthy();
    expect(screen.queryByTestId('table-create')).toBeNull();
    expect(mockState.store.apiFetch).toHaveBeenCalledWith(
      `/api/v1/pos/tables?locationId=${LOCATION.id}`,
      expect.anything(),
    );
  });

  it('lets a Manager create a table at the selected location', async () => {
    signedInAs('manager');
    const writes = api({
      ...tableAnswers,
      'POST /api/v1/pos/tables': () =>
        Response.json({ ...TABLE, id: id(61), name: 'T2', area: null }, { status: 201 }),
    });
    render(<TablesPage />);
    await screen.findByTestId('table-card');
    await userEvent.click(screen.getByTestId('table-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'T2');
    await userEvent.clear(within(dialog).getByLabelText('Seats'));
    await userEvent.type(within(dialog).getByLabelText('Seats'), '0');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Enter 1 to 100 seats.')).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Seats'));
    await userEvent.type(within(dialog).getByLabelText('Seats'), '2');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/pos/tables',
        body: { locationId: LOCATION.id, name: 'T2', seats: 2, area: '' },
      },
    ]);
  });

  it('archives a table after confirming', async () => {
    signedInAs('owner');
    const writes = api({
      ...tableAnswers,
      [`PATCH /api/v1/pos/tables/${TABLE.id}`]: () =>
        Response.json({ ...TABLE, archivedAt: '2026-10-27T12:00:00.000Z' }),
    });
    render(<TablesPage />);
    await screen.findByTestId('table-card');
    await userEvent.click(screen.getByTestId('archive'));
    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByText('T1 is hidden from ordering. Past orders keep it.'),
    ).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PATCH',
      path: `/api/v1/pos/tables/${TABLE.id}`,
      body: { archived: true },
    });
  });
});
