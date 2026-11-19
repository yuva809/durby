// @vitest-environment jsdom
import { type SystemRole, systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { ImportPage } from './import-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

/** The workbook reader works on real .xlsx bytes; here it hands over sheets as it would. */
const excel = vi.hoisted(() => ({ sheets: [] as { sheet: string; data: unknown[][] }[] }));
vi.mock('read-excel-file/browser', () => ({ default: () => Promise.resolve(excel.sheets) }));

beforeEach(resetMocks);
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000008${String(n).padStart(2, '0')}`;

function signedInAs(role: SystemRole, permissions?: string[]) {
  mockState.session = sessionFixture({
    activePermissions: permissions ?? [...systemRolePermissions(role)],
    activeFeatures: ['inventory', 'catalog', 'orders'],
  });
}

function api() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path: input, body: init?.body ? JSON.parse(init.body as string) : null });
    if (method === 'POST') {
      return Promise.resolve(
        Response.json({ created: 2, updated: 1, unchanged: 0, documents: ['GR-2026-000001'] }),
      );
    }
    if (input.startsWith('/api/v1/inventory/warehouses')) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: id(1),
              locationId: id(2),
              name: 'Main',
              sortOrder: 0,
              suppliesStation: null,
              archivedAt: null,
            },
          ],
        }),
      );
    }
    if (input.startsWith('/api/v1/inventory/items')) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: id(3),
              name: 'Rice',
              sku: 'R-1',
              unit: 'pc',
              minQuantity: null,
              parentItemId: null,
              variantValues: [],
              salePrice: null,
              archivedAt: null,
            },
          ],
        }),
      );
    }
    return Promise.resolve(Response.json({ data: [] }));
  });
  return calls;
}

const csv = (text: string, name = 'data.csv') => new File([text], name, { type: 'text/csv' });

describe('Import Data (/import, ADR 0044 step 4)', () => {
  it('offers only the kinds the role may import', () => {
    signedInAs('staff');
    render(<ImportPage />);
    expect(screen.queryByTestId('import-kind-items')).toBeNull();

    signedInAs('staff', ['orders.customers.create']);
    cleanup();
    render(<ImportPage />);
    expect(screen.getByTestId('import-kind-customers')).toBeTruthy();
    expect(screen.queryByTestId('import-kind-items')).toBeNull();
  });

  it('previews items, shows their problems and imports nothing until they are fixed', async () => {
    signedInAs('owner');
    const calls = api();
    render(<ImportPage />);
    await userEvent.click(screen.getByTestId('import-kind-items'));
    expect(screen.getAllByTestId('import-column').map((c) => c.textContent)).toEqual([
      'name',
      'sku',
      'unit',
      'min_quantity',
      'sale_price',
    ]);
    await userEvent.upload(
      screen.getByTestId('import-file'),
      csv('name,unit,sale_price\nRice,pc,12.90\nOil,crate,\n'),
    );
    const preview = await screen.findByTestId('import-preview');
    expect(within(preview).getByText('2 rows')).toBeTruthy();
    expect(within(preview).getByTestId('import-problems').textContent).toContain(
      'Row 2 · unit: not a valid value',
    );
    expect(within(preview).getByTestId<HTMLButtonElement>('import-run').disabled).toBe(true);

    await userEvent.upload(
      screen.getByTestId('import-file'),
      csv('name,unit,sale_price\nRice,pc,12.90\nOil,l,\n'),
    );
    await userEvent.click(await screen.findByTestId('import-run'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/v1/inventory/items/import',
        body: {
          rows: [
            { name: 'Rice', sku: '', unit: 'pc', minQuantity: '', salePrice: '12.90' },
            { name: 'Oil', sku: '', unit: 'l', minQuantity: '', salePrice: '' },
          ],
        },
      }),
    );
    expect((await screen.findByTestId('import-done')).textContent).toContain(
      '2 added, 1 updated, 0 already up to date.',
    );
  });

  it('checks opening stock against the warehouses and items that exist', async () => {
    signedInAs('owner');
    api();
    render(<ImportPage />);
    await userEvent.click(screen.getByTestId('import-kind-opening_stock'));
    await userEvent.upload(
      screen.getByTestId('import-file'),
      csv('warehouse;item;quantity;unit_cost\nMain;R-1;10;8,50\nCold room;Fish;2;5\n'),
    );
    const problems = await screen.findByTestId('import-problems');
    await waitFor(() =>
      expect(problems.textContent).toContain(
        'Row 2 · warehouse: not found (check the name or SKU)',
      ),
    );
    expect(problems.textContent).toContain('Row 2 · item: not found');
    expect(problems.textContent).not.toContain('Row 1');
  });

  it('names missing columns', async () => {
    signedInAs('owner');
    api();
    render(<ImportPage />);
    await userEvent.click(screen.getByTestId('import-kind-customers'));
    await userEvent.upload(screen.getByTestId('import-file'), csv('phone\n123\n'));
    expect(await screen.findByText('Columns missing: name. Start from the template.')).toBeTruthy();
  });

  it('reads an Excel workbook: the sheet named like the import, numbers as stored', async () => {
    signedInAs('owner');
    api();
    excel.sheets = [
      { sheet: 'Notes', data: [['ignore me']] },
      {
        sheet: 'Items',
        data: [
          ['Name', 'Unit', 'Sale price'],
          ['Rice', 'pc', { number: '12.9000000000000004' }],
        ],
      },
    ];
    render(<ImportPage />);
    await userEvent.click(screen.getByTestId('import-kind-items'));
    await userEvent.upload(
      screen.getByTestId('import-file'),
      new File(['xlsx'], 'stock.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    const preview = await screen.findByTestId('import-preview');
    expect(within(preview).getByText('stock.xlsx')).toBeTruthy();
    expect(within(preview).getByText('12.9')).toBeTruthy();
  });

  it('says when a file is neither CSV nor Excel', async () => {
    signedInAs('owner');
    api();
    render(<ImportPage />);
    await userEvent.upload(
      screen.getByTestId('import-file'),
      new File(['x'], 'old.xls', { type: 'application/vnd.ms-excel' }),
      { applyAccept: false },
    );
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });

  it('offers vendor invoices and their approval queue to those who receive goods', () => {
    signedInAs('staff', ['inventory.stock.read', 'inventory.stock.receive']);
    render(<ImportPage />);
    expect(screen.getByTestId('import-invoice-open').getAttribute('href')).toBe(
      '/inventory/invoice',
    );
    expect(screen.getByTestId('import-invoice-queue').getAttribute('href')).toBe(
      '/inventory/invoices',
    );
    // Opening stock is theirs too; items are not.
    expect(screen.getByTestId('import-kind-opening_stock')).toBeTruthy();
    expect(screen.queryByTestId('import-kind-items')).toBeNull();

    cleanup();
    signedInAs('staff', ['orders.customers.create']);
    render(<ImportPage />);
    expect(screen.queryByTestId('import-invoice')).toBeNull();
  });
});
