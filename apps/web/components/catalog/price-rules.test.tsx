// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { CatalogPage } from './catalog-page';
import { PriceRulesPage } from './price-rules-page';

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

const id = (n: number) => `0190a000-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`;
const FOOD = { id: id(1), name: 'Food', sortOrder: 0, station: 'kitchen', archivedAt: null };
const DRINKS = { id: id(2), name: 'Drinks', sortOrder: 1, station: 'bar', archivedAt: null };
const product = (n: number, name: string, categoryId: string, price: string) => ({
  id: id(10 + n),
  categoryId,
  name,
  menuNumber: null,
  description: null,
  price,
  taxRate: '19.00',
  sortOrder: 0,
  archivedAt: null,
});
const SOUP = product(1, 'Soup', FOOD.id, '6.90');
const COLA = product(2, 'Cola', DRINKS.id, '3.80');
const MAIN = { id: id(30), name: 'Main street', brandId: id(90) };
const HAPPY = {
  id: id(40),
  name: 'Happy hour',
  locationId: null,
  productId: null,
  categoryId: DRINKS.id,
  kind: 'percent_off',
  value: '20.00',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  startsAt: '17:00',
  endsAt: '19:00',
  validFrom: null,
  validUntil: null,
  active: true,
};
const prices = (cola: string, timed = false) => ({
  locationId: MAIN.id,
  at: '2026-11-06T17:00:00.000Z',
  data: [
    { productId: SOUP.id, price: '6.90', ruleId: null, ruleName: null, timed: false },
    {
      productId: COLA.id,
      price: cola,
      ruleId: timed ? HAPPY.id : null,
      ruleName: timed ? 'Happy hour' : null,
      timed,
    },
  ],
});

function signedInAs(role: SystemRole) {
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions(role)],
    activeFeatures: ['catalog', 'pos', 'inventory'],
  });
}

type Answer = (url: string) => Response;
function api(extra: Record<string, Answer> = {}) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/\?.*$/, '');
    if (method !== 'GET') {
      writes.push({ method, path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    }
    const answers: Record<string, Answer> = {
      'GET /api/v1/settings': () =>
        Response.json({
          data: [
            { key: 'locale', value: 'en', source: 'default', dataBound: false },
            { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
            { key: 'timezone', value: 'Europe/Berlin', source: 'default', dataBound: false },
          ],
        }),
      'GET /api/v1/catalog/price-rules': () => Response.json({ data: [HAPPY] }),
      'GET /api/v1/catalog/categories': () => Response.json({ data: [FOOD, DRINKS] }),
      'GET /api/v1/catalog/products': () => Response.json({ data: [SOUP, COLA] }),
      'GET /api/v1/locations': () => Response.json({ data: [MAIN] }),
      'GET /api/v1/catalog/prices': () => Response.json(prices('3.80')),
      'POST /api/v1/catalog/price-rules': () => Response.json(HAPPY, { status: 201 }),
      ...extra,
    };
    const answer = answers[`${method} ${path}`];
    return Promise.resolve(answer ? answer(input) : Response.json({ data: [] }));
  });
  return writes;
}

describe('PriceRulesPage (ADR 0030)', () => {
  it('lists rules with target, amount, place and time', async () => {
    signedInAs('manager');
    api();
    render(<PriceRulesPage />);
    const rule = await screen.findByTestId('price-rule');
    expect(rule.dataset.name).toBe('Happy hour');
    expect(within(rule).getByTestId('price-rule-summary').textContent).toBe(
      'Drinks · −20 % · All locations · Mo Tu We Th Fr · 17:00–19:00',
    );
  });

  it('adds a happy hour on a category, checking the rule before sending it', async () => {
    signedInAs('owner');
    const writes = api();
    render(<PriceRulesPage />);
    await userEvent.click(await screen.findByTestId('price-rule-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByTestId('price-rule-name'), 'Happy hour');
    await userEvent.selectOptions(within(dialog).getByTestId('price-rule-category'), DRINKS.id);
    await userEvent.type(within(dialog).getByTestId('price-rule-value'), '20');
    for (const day of ['Mo', 'Fr']) {
      await userEvent.click(within(dialog).getByRole('button', { name: day }));
    }
    await userEvent.type(within(dialog).getByTestId('price-rule-starts'), '17:00');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    expect(within(dialog).getByText('Give both times, and not the same.')).toBeTruthy();
    expect(writes).toEqual([]);

    await userEvent.type(within(dialog).getByTestId('price-rule-ends'), '19:00');
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/api/v1/catalog/price-rules',
      body: {
        name: 'Happy hour',
        locationId: null,
        productId: null,
        categoryId: DRINKS.id,
        kind: 'percent_off',
        value: '20',
        days: ['mon', 'fri'],
        startsAt: '17:00',
        endsAt: '19:00',
        validFrom: null,
        validUntil: null,
        active: true,
      },
    });
  });

  it('gives a single product a fixed price', async () => {
    signedInAs('owner');
    const writes = api();
    render(<PriceRulesPage />);
    await userEvent.click(await screen.findByTestId('price-rule-create'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByTestId('price-rule-name'), 'Main street cola');
    await userEvent.selectOptions(within(dialog).getByTestId('price-rule-target'), 'product');
    await userEvent.selectOptions(within(dialog).getByTestId('price-rule-product'), COLA.id);
    expect(within(dialog).queryByTestId('price-rule-kind')).toBeNull();
    await userEvent.type(within(dialog).getByTestId('price-rule-value'), '4,00');
    await userEvent.selectOptions(within(dialog).getByTestId('price-rule-location'), MAIN.id);
    await userEvent.click(within(dialog).getByTestId('form-save'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toMatchObject({
      productId: COLA.id,
      categoryId: null,
      kind: 'fixed',
      value: '4.00',
      locationId: MAIN.id,
      days: [],
    });
  });

  it('checks prices at a location with the rule that set them; Staff only reads', async () => {
    signedInAs('staff');
    api({ 'GET /api/v1/catalog/prices': () => Response.json(prices('3.04', true)) });
    render(<PriceRulesPage />);
    const rows = await screen.findAllByTestId('price-check-row');
    const cola = rows.find((r) => r.dataset.name === 'Cola')!;
    expect(within(cola).getByTestId('price-check-price').textContent).toBe('€3.04');
    expect(cola.textContent).toContain('Happy hour');
    expect(rows.find((r) => r.dataset.name === 'Soup')!.textContent).toContain('Own price');
    expect(screen.queryByTestId('price-rule-create')).toBeNull();
    expect(screen.queryByTestId('price-rule-delete')).toBeNull();
  });
});

describe('Menu page prices per location', () => {
  it("shows a location's regular price and bases the margin on it", async () => {
    signedInAs('owner');
    const asked: string[] = [];
    api({
      'GET /api/v1/catalog/prices': (url) => {
        asked.push(url);
        return Response.json(prices('4.76'));
      },
      'GET /api/v1/inventory/costs': () =>
        Response.json({
          data: [{ productId: COLA.id, cost: '1.00', complete: true, lines: [] }],
        }),
    });
    render(<CatalogPage />);
    const colaRow = async () =>
      (await screen.findAllByTestId('product-row')).find((r) => r.dataset.name === 'Cola')!;
    expect(within(await colaRow()).getByTestId('product-price').textContent).toBe('3.80');
    await userEvent.selectOptions(await screen.findByTestId('menu-price-location'), MAIN.id);
    await waitFor(async () =>
      expect(within(await colaRow()).getByTestId('product-price').textContent).toBe('4.76'),
    );
    expect(asked.at(-1)).toBe(`/api/v1/catalog/prices?locationId=${MAIN.id}&timed=false`);
    // 4.76 gross at 19 % is 4.00 net: cost 1.00 leaves 75 %.
    expect((await colaRow()).textContent).toContain('75%');
  });
});
