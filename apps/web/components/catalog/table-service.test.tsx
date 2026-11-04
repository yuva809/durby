// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
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
const FOOD = { id: id(1), name: 'Food', sortOrder: 0, station: 'kitchen', archivedAt: null };
const DRINKS = { id: id(2), name: 'Drinks', sortOrder: 1, station: 'kitchen', archivedAt: null };
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
