import type { StockItem, VendorInvoice } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import { type InvoiceLine, linesToRows } from './invoice-pdf';
import {
  amountsOf,
  matchInvoice,
  NEW_ITEM,
  recount,
  rowProblems,
  itemDetailsChange,
  retarget,
  rowsFromInvoice,
  setMissingCategory,
  submitRequest,
} from './invoice-receipt';

const id = (n: number) => `0190a000-0000-7000-8000-0000000050${String(n).padStart(2, '0')}`;
const item = (n: number, name: string, sku: string | null, extra: Partial<StockItem> = {}) =>
  ({
    id: id(n),
    name,
    sku,
    unit: 'pc',
    minQuantity: null,
    parentItemId: null,
    variantValues: [],
    salePrice: null,
    categoryId: null,
    brand: null,
    packCount: null,
    packSize: null,
    packUnit: null,
    archivedAt: null,
    ...extra,
  }) satisfies StockItem;
const line = (code: string | null, description: string, quantity = '1.00', price = '2.00') =>
  ({
    code,
    description,
    quantity,
    unitPrice: price,
    vatRate: '0',
    total: price,
    checks: true,
  }) satisfies InvoiceLine;

const CATFISH = item(1, 'Catfish 4kg', '1103-002');
const TILAPIA = item(2, 'Ultimate Taste Red Tilapia Steaks', null);
const OLD = item(3, 'Old', '9999-001', { archivedAt: '2026-11-01T00:00:00.000Z' });

describe('vendor invoice review (ADR 0049)', () => {
  const lines = [
    line('1103-002', 'Bigi Mama African Catfish 1 x 4kg', '50.00', '11.00'),
    line('2252-001', 'ultimate taste  red tilapia steaks'),
    line('9999-001', 'Something archived'),
    line(null, 'Brand new thing'),
  ];

  it('matches by SKU, then exact name, else new; archived items never', () => {
    expect(matchInvoice(lines, [CATFISH, TILAPIA, OLD]).map((r) => r.target)).toEqual([
      CATFISH.id,
      TILAPIA.id,
      NEW_ITEM,
      NEW_ITEM,
    ]);
  });

  it('flags bad amounts, an item twice, and new items for those who cannot create them', () => {
    const rows = matchInvoice(lines, [CATFISH, TILAPIA]);
    rows[1] = { ...rows[1]!, target: CATFISH.id };
    rows[2] = { ...rows[2]!, quantity: '0' };
    rows[3] = { ...rows[3]!, unitCost: '1.23456' };
    expect(rowProblems(rows, false)).toEqual([
      ['duplicate'],
      ['duplicate'],
      ['quantity', 'newNotAllowed'],
      ['unitCost', 'newNotAllowed'],
    ]);
    // Left out lines have no problems.
    const left = rows[2];
    expect(rowProblems([{ ...left, include: false }], false)).toEqual([[]]);
  });

  it('builds one invoice to submit: existing items by id, new ones with the supplier code as SKU', () => {
    // Every new line without a category gets one at once; per line a unit, a brand and a pack size (ADR 0055).
    const rows = setMissingCategory(matchInvoice(lines, [CATFISH, TILAPIA]), id(80));
    rows[0] = { ...rows[0]!, unitId: id(81) };
    rows[2] = { ...rows[2]!, include: false };
    rows[3] = { ...rows[3]!, brand: ' Bigi ', pack: { count: '12', size: '500', unit: 'g' } };
    expect(
      submitRequest({
        rows,
        warehouseId: id(90),
        supplier: ' Bonesca ',
        note: ' ',
        invoice: { number: '108666', date: '10-11-2026', total: '554.00' },
        fileName: '108666.pdf',
        source: 'pdf',
      }),
    ).toEqual({
      warehouseId: id(90),
      supplier: 'Bonesca',
      invoiceNumber: '108666',
      invoiceDate: '10-11-2026',
      printedTotal: '554.00',
      fileName: '108666.pdf',
      source: 'pdf',
      lines: [
        {
          code: '1103-002',
          description: 'Bigi Mama African Catfish 1 x 4kg',
          itemId: CATFISH.id,
          quantity: '50.00',
          unitCost: '11.00',
          unitId: id(81),
        },
        {
          code: '2252-001',
          description: 'ultimate taste  red tilapia steaks',
          itemId: TILAPIA.id,
          quantity: '1.00',
          unitCost: '2.00',
        },
        {
          description: 'Brand new thing',
          newItem: {
            name: 'Brand new thing',
            unit: 'pc',
            categoryId: id(80),
            brand: 'Bigi',
            packCount: 12,
            packSize: '500',
            packUnit: 'g',
          },
          quantity: '1.00',
          unitCost: '2.00',
        },
      ],
    });
  });

  it('leaves out a printed total the api would refuse, and no category when none is chosen', () => {
    const request = submitRequest({
      rows: matchInvoice([line('7', 'Thing')], [], 'kg'),
      warehouseId: id(90),
      supplier: '',
      note: 'Check the boxes',
      invoice: { number: null, date: null, total: '1.234' },
      fileName: null,
      source: 'scan',
    });
    expect(request).toEqual({
      warehouseId: id(90),
      note: 'Check the boxes',
      source: 'scan',
      lines: [
        {
          code: '7',
          description: 'Thing',
          newItem: { name: 'Thing', sku: '7', unit: 'kg' },
          quantity: '1.00',
          unitCost: '2.00',
        },
      ],
    });
  });
});

describe('a stored invoice back as rows (ADR 0054)', () => {
  const stored = (lines: VendorInvoice['lines']): VendorInvoice => ({
    id: id(70),
    number: 'VIN-2026-000001',
    status: 'pending',
    warehouseId: id(90),
    warehouseName: 'Main',
    supplier: 'Bonesca',
    invoiceNumber: '108666',
    invoiceDate: null,
    lineCount: lines.length,
    newItemCount: 1,
    total: '0.00',
    printedTotal: null,
    submittedByName: null,
    createdAt: '2026-11-18T10:00:00.000Z',
    decidedAt: null,
    note: null,
    fileName: null,
    source: 'pdf',
    rejectReason: null,
    decidedByName: null,
    documentId: null,
    documentNumber: null,
    lines,
  });

  it('keeps items and new items, and trims stored zeros as a person types them', () => {
    const rows = rowsFromInvoice(
      stored([
        {
          id: id(71),
          position: 1,
          code: '1103-002',
          description: 'Bigi Mama African Catfish 1 x 4kg',
          itemId: CATFISH.id,
          itemName: CATFISH.name,
          newItem: null,
          itemDetails: null,
          unitId: id(81),
          unitSymbol: 'CTN',
          quantity: '50.000',
          unitCost: '11.0000',
          value: '550.00',
          expiresOn: null,
        },
        {
          id: id(72),
          position: 2,
          code: null,
          description: 'brand new thing',
          itemId: null,
          itemName: null,
          newItem: {
            name: 'Brand new thing',
            sku: null,
            unit: 'pc',
            categoryId: id(80),
            brand: 'Bigi',
            packCount: 12,
            packSize: '0.500',
            packUnit: 'kg',
          },
          itemDetails: null,
          unitId: null,
          unitSymbol: null,
          quantity: '120',
          unitCost: '0.4150',
          value: '49.80',
          expiresOn: null,
        },
      ]),
    );
    expect(rows.map((r) => [r.target, r.line.description, r.quantity, r.unitCost])).toEqual([
      [CATFISH.id, 'Bigi Mama African Catfish 1 x 4kg', '50', '11.00'],
      [NEW_ITEM, 'Brand new thing', '120', '0.415'],
    ]);
    expect(rows.every((r) => r.include)).toBe(true);
    // The invoiced-in unit, and the new item's category, brand and pack size come back as typed (ADR 0055).
    expect(rows[0]!.unitId).toBe(id(81));
    expect(rows[1]).toMatchObject({
      categoryId: id(80),
      brand: 'Bigi',
      pack: { count: '12', size: '0.5', unit: 'kg' },
    });
  });
});

describe('scanned lines as rows', () => {
  const read = (text: string, page: number, x0: number, y0: number, y1 = y0 + 20) => ({
    text,
    page,
    box: { x0, x1: x0 + 50, y0, y1 },
  });

  it('joins pieces on one line left to right, per page in order', () => {
    expect(
      linesToRows([
        read('11.00', 1, 400, 102),
        read('1103-002 Catfish', 1, 10, 100),
        read('50', 1, 300, 98),
        read('Second line', 1, 10, 140),
        read('Page two', 2, 10, 10),
        read('  ', 1, 10, 200),
      ]),
    ).toEqual(['1103-002 Catfish 50 11.00', 'Second line', 'Page two']);
  });
});

describe('an existing item’s details on the invoice (ADR 0055)', () => {
  const PACKED = item(4, 'Croaker 5 x 2kg', '1971-002', {
    categoryId: id(80),
    brand: 'OD',
    packCount: 5,
    packSize: '2.000',
    packUnit: 'kg',
  });

  it('starts from the item’s own, filling a missing pack size from the description', () => {
    const [plain, packed] = matchInvoice(
      [line('1103-002', 'Catfish 1 x 4kg'), line('1971-002', 'OD Yellow Croakers 10 x 1kg')],
      [CATFISH, PACKED],
    );
    expect(plain).toMatchObject({ categoryId: '', brand: '', pack: { count: '1', size: '4' } });
    // The item's own pack size wins over the description's.
    expect(packed).toMatchObject({
      categoryId: id(80),
      brand: 'OD',
      pack: { count: '5', size: '2', unit: 'kg' },
    });
  });

  it('sends only what changes, and follows the item when another is chosen', () => {
    const [row] = matchInvoice([line('1971-002', 'Croaker')], [PACKED]);
    expect(itemDetailsChange(row!, PACKED)).toBeUndefined();
    expect(itemDetailsChange({ ...row!, brand: 'Ocean Delight' }, PACKED)).toEqual({
      brand: 'Ocean Delight',
    });
    expect(
      itemDetailsChange({ ...row!, pack: { count: '5', size: '2.5', unit: 'kg' } }, PACKED),
    ).toEqual({ packSize: '2.5', packUnit: 'kg' });
    const fresh = retarget(row!, NEW_ITEM, [PACKED]);
    expect(fresh).toMatchObject({ target: NEW_ITEM, categoryId: '', brand: '', unitId: '' });
    expect(retarget(fresh, PACKED.id, [PACKED])).toMatchObject({ brand: 'OD' });
  });
});

describe('packed lines as invoiced or by the piece (ADR 0058)', () => {
  // 4 cartons of 12 for 120.48: 30.12 a carton, 2.51 a piece.
  const packed = {
    code: '10434',
    description: 'GOLDEN MORN 12x300GR',
    quantity: '4',
    unitPrice: '30.12',
    vatRate: null,
    total: '120.48',
    checks: true,
    pack: { count: '4', per: '12', unit: 'CAR', pieces: '48', piecePrice: '2.51' },
  } satisfies InvoiceLine;
  const single = line('2252-001', 'ultimate taste red tilapia steaks', '3', '2.00');

  it('counts packed lines either way; other lines the same both ways', () => {
    expect(amountsOf(packed, 'invoiced')).toEqual({ quantity: '4', unitCost: '30.12' });
    expect(amountsOf(packed, 'pieces')).toEqual({ quantity: '48', unitCost: '2.51' });
    expect(amountsOf(single, 'pieces')).toEqual({ quantity: '3', unitCost: '2.00' });
    const rows = matchInvoice([packed, single], [TILAPIA], 'pc', 'pieces');
    expect(rows.map((r) => [r.target, r.quantity, r.unitCost])).toEqual([
      [NEW_ITEM, '48', '2.51'],
      [TILAPIA.id, '3', '2.00'],
    ]);
  });

  it('recounts every row from its line, keeping what else was chosen', () => {
    const rows = matchInvoice([packed, single], [TILAPIA]);
    rows[0] = { ...rows[0]!, quantity: '5', include: false };
    const pieces = recount(rows, 'pieces');
    expect(pieces[0]).toMatchObject({ quantity: '48', unitCost: '2.51', include: false });
    expect(pieces[1]).toMatchObject({ quantity: '3', unitCost: '2.00', target: TILAPIA.id });
    expect(recount(pieces, 'invoiced')[0]).toMatchObject({ quantity: '4', unitCost: '30.12' });
  });
});
