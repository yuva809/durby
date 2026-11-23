// @vitest-environment jsdom
import { systemRolePermissions } from '@durby/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(within(lines[0]!).getByTestId('invoice-line-item').getAttribute('data-value')).toBe(
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
    // The new item's name is the description until edited; an empty name stops the import.
    const name = within(lines[1]!).getByTestId<HTMLInputElement>('invoice-line-new-name');
    expect(name.value).toBe('OD Yellow Croakers WG 500-1000g IPB 5 x 2kg -SR');
    await userEvent.clear(name);
    expect(within(lines[1]!).getByTestId('invoice-line-problem').textContent).toBe(
      'Give the new item a name.',
    );
    await userEvent.type(name, 'Yellow Croaker 2kg');
    await userEvent.selectOptions(
      within(lines[0]!).getByTestId('invoice-line-invoiced-in'),
      CARTON.id,
    );
    // Costs are read and sent, not shown (ADR 0062); best before as printed.
    expect(screen.queryByTestId('invoice-line-cost')).toBeNull();
    fireEvent.change(within(lines[0]!).getByTestId('invoice-line-expiry'), {
      target: { value: '2027-03-31' },
    });
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
            expiresOn: '2027-03-31',
            // The matched product had no category or pack size: set on it when approved (ADR 0055).
            itemDetails: { categoryId: FISH.id, packCount: 1, packSize: '4', packUnit: 'kg' },
          },
          {
            code: '1971-002',
            description: 'OD Yellow Croakers WG 500-1000g IPB 5 x 2kg -SR',
            newItem: {
              name: 'Yellow Croaker 2kg',
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

  it('finds the product of a line by typing part of its name or SKU', async () => {
    signedIn();
    api();
    render(<InvoiceImportPage />);
    await userEvent.upload(await screen.findByTestId('invoice-file'), pdfFile());
    const lines = await screen.findAllByTestId('invoice-line');
    const picker = within(lines[1]!).getByTestId('invoice-line-item');
    expect(picker.getAttribute('data-value')).not.toBe(CATFISH.id);

    await userEvent.click(picker);
    const panel = await screen.findByTestId('invoice-line-item-panel');
    // "New item" first, then the catalogue.
    expect(within(panel).getByTestId('invoice-line-item-new')).toBeTruthy();
    const search = within(panel).getByTestId('invoice-line-item-search');
    await userEvent.type(search, 'zzz');
    expect(within(panel).queryAllByTestId('invoice-line-item-option')).toHaveLength(0);
    expect(panel.textContent).toContain('No product matches');
    // Part of the SKU finds it; Enter picks the first match.
    await userEvent.clear(search);
    await userEvent.type(search, '1103');
    expect(
      within(panel)
        .getAllByTestId('invoice-line-item-option')
        .map((o) => o.textContent),
    ).toEqual(['Catfish 4kg · 1103-002']);
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByTestId('invoice-line-item-panel')).toBeNull();
    expect(within(lines[1]!).getByTestId('invoice-line-item').getAttribute('data-value')).toBe(
      CATFISH.id,
    );
  });

  it('counts packed lines as invoiced or by the piece, and skips transport (ADR 0058)', async () => {
    signedIn();
    const writes = api();
    // A wholesaler's packed lines: code, description, origin, pack unit, packs, per pack, free, pieces, price, total.
    pdf.rows = [
      'INVOICE',
      '10163527',
      '07.11.2026',
      '10434 GOLDEN MORN 12x300GR NG CAR 4 12,000 0,000 48,000 2,51 120,48 41%',
      '8030 NOODLES CHICKEN 40x70GR TH CAR 10 40,000 0,000 400,000 10,54 105,40 41%',
      '3964 SARDINES IN OIL 40x125GR MA CAR 10 40,000 0,000 400,000 10,15 101,50 41%',
      '9497 TRASPORTO IT PC 2 1,000 0,000 2,000 0,00 0,00 E7',
      '327,38',
    ];
    render(<InvoiceImportPage />);
    await userEvent.upload(await screen.findByTestId('invoice-file'), pdfFile());
    expect(await screen.findAllByTestId('invoice-line')).toHaveLength(3);
    // Costs are not shown on the import (ADR 0062): the quantities here, the costs in what is sent.
    const amounts = () =>
      screen
        .getAllByTestId('invoice-line')
        .map((l) => within(l).getByTestId<HTMLInputElement>('invoice-line-quantity').value);
    const first = screen.getAllByTestId('invoice-line')[0]!;
    expect(within(first).getByTestId('invoice-line-packed').textContent).toBe(
      '4 CAR × 12 = 48 pcs',
    );
    expect(screen.getByTestId<HTMLInputElement>('invoice-number').value).toBe('10163527');
    expect(screen.getByTestId('invoice-count-skipped').textContent).toBe(
      'Skipped, not goods: TRASPORTO',
    );
    // As invoiced first: cartons at the carton price.
    expect(screen.getByTestId('invoice-count-invoiced').getAttribute('aria-checked')).toBe('true');
    expect(amounts()).toEqual(['4', '10', '10']);
    expect(screen.getByTestId('invoice-total-check').textContent).toContain('Matches');

    // By the piece: 0.25375 a sardine tin is kept as 0.2538, 2 cents over the paper, said so.
    await userEvent.click(screen.getByTestId('invoice-count-pieces'));
    expect(amounts()).toEqual(['48', '400', '400']);
    expect(screen.getByTestId('invoice-total-check').textContent).toContain(
      'apart from €0.02 from rounding piece prices',
    );
    await userEvent.click(screen.getByTestId('invoice-submit'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      invoiceNumber: '10163527',
      printedTotal: '327.38',
      lines: [
        { code: '10434', quantity: '48', unitCost: '2.51' },
        { code: '8030', quantity: '400', unitCost: '0.2635' },
        { code: '3964', quantity: '400', unitCost: '0.2538' },
      ],
    });
  });
});
