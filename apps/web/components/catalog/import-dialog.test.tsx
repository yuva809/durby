// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { CatalogPage } from './catalog-page';
import { ImportDialog } from './import-dialog';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

beforeEach(() => {
  resetMocks();
  mockState.session = sessionFixture({
    activePermissions: [...systemRolePermissions('owner')],
    activeFeatures: ['catalog'],
  });
});
afterEach(cleanup);

const PRODUCT_ID = '0190a000-0000-7000-8000-000000000301';

function api(importAnswer: () => Response) {
  const posts: unknown[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    if (input === '/api/v1/catalog/products/import' && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Promise.resolve(importAnswer());
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
  return posts;
}

const csv = (text: string) => new File([text], 'menu.csv', { type: 'text/csv' });

async function choose(text: string) {
  await userEvent.click(screen.getByTestId('import-open'));
  await userEvent.upload(await screen.findByTestId('import-file'), csv(text));
}

describe('ImportDialog', () => {
  it('previews a clean file, imports it and shows the summary', async () => {
    const onDone = vi.fn();
    const posts = api(() =>
      Response.json({
        created: 1,
        updated: 1,
        unchanged: 0,
        categoriesCreated: 1,
        rows: [
          { row: 1, status: 'created', productId: PRODUCT_ID },
          { row: 2, status: 'updated', productId: PRODUCT_ID },
        ],
      }),
    );
    render(<ImportDialog onDone={onDone} />);
    await choose('category;name;price;tax_rate\nBBQ;So-Galbi;24,90;7\nDrinks;Soju;7;19\n');
    expect((await screen.findByTestId('import-ready')).textContent).toBe('2 rows ready to import.');
    expect(screen.getByTestId('import-preview').textContent).toContain('So-Galbi');
    await userEvent.click(screen.getByTestId('import-submit'));
    expect((await screen.findByTestId('import-summary')).textContent).toBe(
      'Done: 1 created · 1 updated · 0 unchanged · 1 new categories.',
    );
    expect(posts).toEqual([
      {
        rows: [
          { category: 'BBQ', name: 'So-Galbi', price: '24.90', taxRate: '7' },
          { category: 'Drinks', name: 'Soju', price: '7', taxRate: '19' },
        ],
      },
    ]);
    expect(onDone).toHaveBeenCalled();
  });

  it('lists row problems and sends nothing', async () => {
    const posts = api(() => Response.json({}, { status: 500 }));
    render(<ImportDialog onDone={vi.fn()} />);
    await choose('category,name,price,tax_rate\n,Ramen,12,7\nDrinks,Soju,abc,19\n');
    const problems = await screen.findByTestId('import-problems');
    expect(problems.textContent).toContain('Row 1, Category: missing');
    expect(problems.textContent).toContain('Row 2, Price: not a valid value');
    expect(screen.getByTestId<HTMLButtonElement>('import-submit').disabled).toBe(true);
    expect(posts).toEqual([]);
  });

  it('explains a file without the needed columns', async () => {
    api(() => Response.json({}));
    render(<ImportDialog onDone={vi.fn()} />);
    await choose('name,price\nSoju,7\n');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Columns missing: Category, VAT %.',
    );
    expect(screen.queryByTestId('import-submit')).toBeNull();
  });
});

describe('CatalogPage', () => {
  it('offers Import CSV only to those who manage products', async () => {
    api(() => Response.json({}));
    render(<CatalogPage />);
    await waitFor(() => expect(screen.getByTestId('import-open')).toBeTruthy());
    cleanup();
    mockState.session = sessionFixture({
      activePermissions: [...systemRolePermissions('manager')],
      activeFeatures: ['catalog'],
    });
    render(<CatalogPage />);
    expect(screen.queryByTestId('import-open')).toBeNull();
  });
});
