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

/**
 * The PDF reader (pdfjs) and on-device recognition are the browser's; here they hand over rows of Bonesca order
 * 108666. `noText`: the PDF has no text layer; `scanFails`: recognition reads nothing either.
 */
const pdf = vi.hoisted(() => ({
  rows: [] as string[],
  noText: false,
  scanFails: false,
  scanned: [] as File[][],
}));
vi.mock('../../lib/inventory/invoice-pdf', async (original) => {
  const real = await original<typeof import('../../lib/inventory/invoice-pdf')>();
  return {
    ...real,
    pdfRows: () =>
      pdf.noText ? Promise.reject(new real.InvoicePdfError('noText')) : Promise.resolve(pdf.rows),
    scanRows: (files: File[]) => {
      pdf.scanned.push(files);
      return pdf.scanFails
        ? Promise.reject(new real.InvoicePdfError('noText'))
        : Promise.resolve(pdf.rows);
    },
  };
});

beforeEach(() => {
  resetMocks();
  pdf.noText = false;
  pdf.scanFails = false;
  pdf.scanned = [];
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
/** Units of measurement (ADR 0038): the supplier invoices catfish per carton of 12. */
const CARTON = {
  id: id(5),
  name: 'Carton',
  symbol: 'CTN',
  baseUnit: 'pc',
  factor: '12.000000',
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
            number: 'VIN-2026-000001',
            status: 'pending',
            warehouseId: WAREHOUSE.id,
            warehouseName: 'Main Warehouse',
            supplier: 'Bonesca',
            invoiceNumber: '108666',
            invoiceDate: '10-11-2026',
            lineCount: 2,
            newItemCount: 1,
            total: '1795.00',
            printedTotal: '1795.00',
            submittedByName: null,
            createdAt: '2026-11-18T10:00:00.000Z',
            decidedAt: null,
            note: null,
            fileName: '108666.pdf',
            source: 'pdf',
            rejectReason: null,
            decidedByName: null,
            documentId: null,
            documentNumber: null,
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
      '/api/v1/inventory/units': { data: [CARTON] },
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

describe('/inventory/invoice (ADR 0049, 0054)', () => {
  it('reads the PDF, matches by SKU, marks new items, and sends it for approval', async () => {
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
    expect(screen.getByTestId<HTMLInputElement>('invoice-number').value).toBe('108666');
    expect(screen.getByTestId<HTMLInputElement>('invoice-date').value).toBe('10-11-2026');
    expect(screen.getByTestId<HTMLInputElement>('invoice-note').value).toBe('');
    // Counts like the paper: 2 items, 1 already a product, 1 new; the supplier wasn't read.
    expect(screen.getByTestId('invoice-summary').textContent).toBe('2 items1 existing1 new');
    expect(screen.getByTestId('invoice-supplier-hint')).toBeTruthy();
    expect(screen.getByTestId('invoice-total-check').textContent).toContain('Matches');

    await userEvent.type(screen.getByTestId('invoice-supplier'), 'Bonesca');
    // A matched product without a pack size gets the one from the description, editable.
    expect(within(lines[0]!).getByTestId<HTMLInputElement>('invoice-line-pack-size').value).toBe(
      '4',
    );
    // Category for every line without one, at once; the pack size was read from the description (ADR 0055).
    await userEvent.selectOptions(screen.getByTestId('invoice-bulk-category-select'), FISH.id);
    await userEvent.click(screen.getByTestId('invoice-bulk-category-apply'));
    expect(within(lines[1]!).getByTestId<HTMLSelectElement>('invoice-line-category').value).toBe(
      FISH.id,
    );
    expect(within(lines[1]!).getByTestId<HTMLInputElement>('invoice-line-pack-count').value).toBe(
      '5',
    );
    await userEvent.type(within(lines[1]!).getByTestId('invoice-line-brand'), 'OD');
    await userEvent.selectOptions(
      within(lines[0]!).getByTestId('invoice-line-invoiced-in'),
      CARTON.id,
    );
    await userEvent.click(screen.getByTestId('invoice-submit'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      path: '/api/v1/inventory/invoices',
      body: {
        warehouseId: WAREHOUSE.id,
        supplier: 'Bonesca',
        invoiceNumber: '108666',
        invoiceDate: '10-11-2026',
        printedTotal: '1795.00',
        fileName: '108666.pdf',
        source: 'pdf',
        lines: [
          {
            code: '1103-002',
            description: 'Bigi Mama African Catfish WG 800-1000gr IQF 1 x 4kg 20% -VN',
            itemId: CATFISH.id,
            quantity: '50.00',
            unitCost: '11.00',
            unitId: CARTON.id,
            // The matched product had no category or pack size: set on it when approved (ADR 0055).
            itemDetails: { categoryId: FISH.id, packCount: 1, packSize: '4', packUnit: 'kg' },
          },
          {
            code: '1971-002',
            description: 'OD Yellow Croakers WG 500-1000g IPB 5 x 2kg -SR',
            newItem: {
              name: 'OD Yellow Croakers WG 500-1000g IPB 5 x 2kg -SR',
              sku: '1971-002',
              unit: 'pc',
              categoryId: FISH.id,
              brand: 'OD',
              packCount: 5,
              packSize: '2',
              packUnit: 'kg',
            },
            quantity: '30.00',
            unitCost: '41.50',
          },
        ],
      },
    });
    const done = await screen.findByTestId('invoice-done');
    expect(done.textContent).toContain('Sent for approval as VIN-2026-000001');
    expect(pdf.scanned).toHaveLength(0);
  });

  it('reads photos on the device and sends them as a scan', async () => {
    signedIn();
    const writes = api();
    render(<InvoiceImportPage />);
    const photos = [
      new File(['jpg'], 'page-1.jpg', { type: 'image/jpeg' }),
      new File(['jpg'], 'page-2.jpg', { type: 'image/jpeg' }),
    ];
    await userEvent.upload(await screen.findByTestId('invoice-file'), photos);
    expect(await screen.findByTestId('invoice-scanned')).toBeTruthy();
    expect(pdf.scanned).toEqual([photos]);
    expect(screen.getAllByTestId('invoice-line')).toHaveLength(2);
    await userEvent.click(screen.getByTestId('invoice-submit'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({ source: 'scan', fileName: '2 photos' });
  });

  it('reads a PDF without text as a scan, and says so when nothing can be read', async () => {
    signedIn();
    api();
    pdf.noText = true;
    pdf.scanFails = true;
    render(<InvoiceImportPage />);
    await userEvent.upload(await screen.findByTestId('invoice-file'), pdfFile());
    expect(await screen.findByText(/No text could be read from this file/)).toBeTruthy();
    expect(pdf.scanned).toHaveLength(1);
  });

  it('lets someone who only receives goods propose new items: the approver creates them', async () => {
    signedIn(['inventory.stock.read', 'inventory.stock.receive']);
    api();
    render(<InvoiceImportPage />);
    await userEvent.upload(await screen.findByTestId('invoice-file'), pdfFile());
    expect(await screen.findByTestId('invoice-line-new')).toBeTruthy();
    expect(screen.queryByTestId('invoice-line-problem')).toBeNull();
    expect(screen.getByTestId('invoice-submit')).toHaveProperty('disabled', false);
  });
});
