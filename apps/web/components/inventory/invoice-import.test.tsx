// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetMocks } from '../../test/mocks';
import { sessionFixture } from '../../test/session-fixture';
import { InvoiceImportPage } from './invoice-import-page';

vi.mock('../../app/providers', async () => (await import('../../test/mocks')).providersMock());
vi.mock('../../app/labels-provider', async () => (await import('../../test/mocks')).labelsMock());
vi.mock('next/navigation', async () => (await import('../../test/mocks')).navigationMock());

/** The PDF reader (pdfjs) is the browser's; here it hands over rows of Bonesca order 108666. */
const pdf = vi.hoisted(() => ({ rows: [] as string[], fail: null as string | null }));
vi.mock('../../lib/inventory/invoice-pdf', async (original) => {
  const real = await original<typeof import('../../lib/inventory/invoice-pdf')>();
  return {
    ...real,
    pdfRows: () =>
      pdf.fail ? Promise.reject(new real.InvoicePdfError('noText')) : Promise.resolve(pdf.rows),
  };
});

beforeEach(() => {
  resetMocks();
  pdf.fail = null;
  pdf.rows = [
    'Order confirmation',
    'Order number : 108666 Customer ID : 91211',
    'Order date : 10-11-2026',
    'Product ID Description Qty Unit price VAT Total',
    '1103-002 Bigi Mama African Catfish WG 800-1000gr IQF 1 x 4kg 20% -VN 50,00 € 11,00 0 % € 550,00',
    '1971-002 OD Yellow Croakers WG 500-1000g IPB 5 x 2kg -SR 30,00 € 41,50 0 % € 1.245,00',
    'Total € 1.795,00',
  ];
});
afterEach(cleanup);

const id = (n: number) => `0190a000-0000-7000-8000-0000000051${String(n).padStart(2, '0')}`;
const WAREHOUSE = {
  id: id(1),
  locationId: id(2),
  name: 'Main Warehouse',
  sortOrder: 0,
  suppliesStation: null,
  isTransit: false,
  archivedAt: null,
};
const CATFISH = {
  id: id(3),
  name: 'Catfish 4kg',
  sku: '1103-002',
  unit: 'pc',
  minQuantity: null,
  parentItemId: null,
  variantValues: [],
  salePrice: null,
  categoryId: null,
  archivedAt: null,
};
const FISH = {
  id: id(4),
  name: 'Frozen fish',
  sortOrder: 0,
  station: 'kitchen',
  description: null,
  parentId: null,
  imageVersion: null,
  archivedAt: null,
};

function api() {
  const writes: { path: string; body: unknown }[] = [];
  mockState.store.apiFetch.mockImplementation((input: string, init?: RequestInit) => {
    const path = input.replace(/\?.*$/, '');
    if (init?.method === 'POST') {
      writes.push({ path, body: JSON.parse(init.body as string) });
      return Promise.resolve(
        Response.json(
          {
            id: id(9),
            number: 'GR-2026-000012',
            kind: 'receipt',
            warehouseId: WAREHOUSE.id,
            toWarehouseId: null,
            reason: null,
            supplier: 'Bonesca',
            note: null,
            createdAt: '2026-11-18T10:00:00.000Z',
            warehouseName: 'Main Warehouse',
            toWarehouseName: null,
            lineCount: 2,
            value: '1795.00',
            lines: [],
          },
          { status: 201 },
        ),
      );
    }
    const answers: Record<string, unknown> = {
      '/api/v1/inventory/warehouses': { data: [WAREHOUSE] },
      '/api/v1/inventory/items': { data: [CATFISH] },
      '/api/v1/catalog/categories': { data: [FISH] },
      '/api/v1/settings': {
        data: [
          { key: 'locale', value: 'en', source: 'default', dataBound: false },
          { key: 'currency', value: 'EUR', source: 'default', dataBound: true },
        ],
      },
    };
    return Promise.resolve(Response.json(answers[path] ?? { data: [] }));
  });
  return writes;
}

function signedIn(permissions = [...systemRolePermissions('owner')]) {
  mockState.session = sessionFixture({
    activePermissions: permissions,
    activeFeatures: ['inventory', 'catalog', 'orders'],
  });
}

const pdfFile = () => new File(['%PDF'], '108666.pdf', { type: 'application/pdf' });

describe('/inventory/invoice (ADR 0049)', () => {
  it('reads the PDF, matches by SKU, marks new items, and imports one receipt', async () => {
    signedIn();
    const writes = api();
    render(<InvoiceImportPage />);
    await userEvent.upload(await screen.findByTestId('invoice-file'), pdfFile());
    const lines = await screen.findAllByTestId('invoice-line');
    expect(lines).toHaveLength(2);
    expect(within(lines[0]!).getByTestId<HTMLSelectElement>('invoice-line-item').value).toBe(
      CATFISH.id,
    );
    expect(within(lines[1]!).getByTestId('invoice-line-new')).toBeTruthy();
    expect(screen.getByTestId<HTMLInputElement>('invoice-note').value).toBe(
      'Order 108666 · 10-11-2026',
    );
    expect(screen.getByTestId('invoice-total-check').textContent).toContain('Matches');

    await userEvent.type(screen.getByTestId('invoice-supplier'), 'Bonesca');
    await userEvent.selectOptions(screen.getByTestId('invoice-new-category'), FISH.id);
    await userEvent.click(screen.getByTestId('invoice-import'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: '/api/v1/inventory/receipts/import',
      body: {
        warehouseId: WAREHOUSE.id,
        supplier: 'Bonesca',
        note: 'Order 108666 · 10-11-2026',
        lines: [
          { itemId: CATFISH.id, quantity: '50.00', unitCost: '11.00' },
          {
            newItem: {
              name: 'OD Yellow Croakers WG 500-1000g IPB 5 x 2kg -SR',
              sku: '1971-002',
              unit: 'pc',
              categoryId: FISH.id,
            },
            quantity: '30.00',
            unitCost: '41.50',
          },
        ],
      },
    });
    expect((await screen.findByTestId('invoice-done')).textContent).toContain('GR-2026-000012');
  });

  it('says why a PDF without text cannot be read', async () => {
    signedIn();
    api();
    pdf.fail = 'noText';
    render(<InvoiceImportPage />);
    await userEvent.upload(await screen.findByTestId('invoice-file'), pdfFile());
    expect(await screen.findByText(/no text \(a scan or photo\)/)).toBeTruthy();
  });

  it('keeps new lines from importing for someone who cannot create items', async () => {
    signedIn(['inventory.stock.read', 'inventory.stock.receive']);
    api();
    render(<InvoiceImportPage />);
    await userEvent.upload(await screen.findByTestId('invoice-file'), pdfFile());
    expect(await screen.findByTestId('invoice-line-problem')).toBeTruthy();
    expect(screen.getByTestId('invoice-import')).toHaveProperty('disabled', true);
    // Leaving the new line out lets the rest go.
    await userEvent.click(screen.getAllByTestId('invoice-line-include')[1]!);
    expect(screen.getByTestId('invoice-import')).toHaveProperty('disabled', false);
  });
});
