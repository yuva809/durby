import { describe, expect, it } from 'vitest';
import { linesTotal, parseAmount, parseInvoice, parseInvoiceRow } from './invoice-pdf';

/** Rows as the PDF reader groups them, from Bonesca order confirmation 108666 (10-11-2026). */
const BONESCA = [
  'Asia-Might (Murugaiah) Delivery to:',
  'Order confirmation',
  'Order number : 108666 Customer ID : 91211',
  'Order date : 10-11-2026 Your reference :',
  'Payment terms : Netto 30 dagen Transportation date : 10-11-2026',
  'Product ID Description Qty Unit price VAT Total',
  '1103-002 Bigi Mama African Catfish WG 800-1000gr IQF 1 x 4kg 20% -VN 50,00 € 11,00 0% € 550,00',
  '1971-002 OD Yellow Croakers WG 500-1000g IPB 5 x 2kg -SR 30,00 € 41,50 0% € 1.245,00',
  '2252-001 Ultimate Taste Red Tilapia Steaks 150-300g IQF 4x1kg 20% -CN 8,00 € 14,00 0% € 112,00',
  '7050-001 Pacific Oyster WR 86-110g IQF 1 x 10kg NW -JP 1,00 € 49,90 0% € 49,90',
  '8110-001 Smoked Souphen Halal Tray 8 pcs/box -FR 40,00 € 4,15 0% € 166,00',
  '8762-003 Tasty Yellow Corn Pap/Akamu/Ogi 60 x 300 gr - CM 2,00 € 69,00 0% € 138,00',
  '8841-003 TYJ Spring Roll Pastry 190mm 50 leaves 20 x 550g-SG 3,00 € 41,00 0% € 123,00',
  '8040-011 v/d Meer Cleaned Hen Halal IWP 12 x 900g -NL 5,00 € 28,00 0% € 140,00',
  'All transactions are subject to our general terms and conditions as stated on the website.',
  'Total net weigt: 1.531 kg',
  'Total excluding VAT € 5.739,80',
  'VAT € 0,00',
  'Total € 5.739,80',
  'Schulpengat 9 • 8321 WC URK • The Netherlands • E-mail: info@bonesca.nl',
];

describe('vendor invoice PDF (ADR 0049)', () => {
  it('reads amounts in either notation', () => {
    expect(parseAmount('1.245,00')).toBe('1245.00');
    expect(parseAmount('50,00')).toBe('50.00');
    expect(parseAmount('1,245.50')).toBe('1245.50');
    expect(parseAmount('€ 4,15')).toBe('4.15');
    expect(parseAmount('41.5')).toBe('41.5');
    expect(parseAmount('abc')).toBeNull();
  });

  it('reads the table rows of a Bonesca order: code, description, quantity, price, VAT, total', () => {
    const invoice = parseInvoice(BONESCA);
    expect(invoice.lines).toHaveLength(8);
    expect(invoice.lines[0]).toEqual({
      code: '1103-002',
      description: 'Bigi Mama African Catfish WG 800-1000gr IQF 1 x 4kg 20% -VN',
      quantity: '50.00',
      unitPrice: '11.00',
      vatRate: '0',
      total: '550.00',
      checks: true,
    });
    expect(invoice.lines[1]).toMatchObject({
      quantity: '30.00',
      unitPrice: '41.50',
      total: '1245.00',
    });
    expect(invoice.lines[5]!.description).toBe('Tasty Yellow Corn Pap/Akamu/Ogi 60 x 300 gr - CM');
    expect(invoice.lines.every((l) => l.checks)).toBe(true);
  });

  it('finds the order number, date, supplier and grand total; skips headers, totals and notes', () => {
    const invoice = parseInvoice(BONESCA);
    expect(invoice).toMatchObject({
      number: '108666',
      date: '10-11-2026',
      supplier: 'Bonesca',
      total: '5739.80',
    });
    expect(linesTotal(invoice.lines)).toBe('2523.90');
  });

  it('flags a row whose quantity × price is not its total', () => {
    expect(parseInvoiceRow('9999-001 Odd line 2,00 € 10,00 0% € 25,00')?.checks).toBe(false);
    expect(parseInvoiceRow('Plain line without a code 3 4.50 13.50')).toMatchObject({
      code: null,
      quantity: '3',
      total: '13.50',
      checks: true,
    });
    expect(parseInvoiceRow('Product ID Description Qty Unit price VAT Total')).toBeNull();
    expect(parseInvoiceRow('Total € 5.739,80')).toBeNull();
  });
});

/** Rows of a packed wholesale invoice (invoice 10163527, 07.11.2026): product lines, headings and totals only. */
const PACKED_INVOICE = [
  'INVOICE',
  '10163527',
  '07.11.2026',
  '10434 GOLDEN MORN 12x300GR NG CAR 4 12,000 0,000 48,000 2,51 120,48 41%',
  'Cod.Int.: 185643 L/Data: 20.03.2027',
  '8030 NOODLES INDOMIE SPECIAL CHICKEN40x70GR TH CAR 10 40,000 0,000 400,000 10,54 105,40 41%',
  '1593 MALTA GUINNES BOTTLE 24x330ML GB CAR 5 24,000 0,000 120,000 1,04 124,80 41%',
  '1593 MALTA GUINNES BOTTLE 24x330ML GB CAR 1 24,000 0,000 24,000 0,00 0,00 41%',
  '9051 LION CURRY 12x25GR MA CNF 4 12,000 0,000 48,000 1,01 48,48 41%',
  '9497 TRASPORTO IT PC 2 1,000 0,000 2,000 0,00 0,00 E7',
  '1 ORDER CONFIRMED CO PC 2 1,000 0,000 2,000 0,00 0,00 41%',
  '399,16',
  'Exempt art 41 DPR 399,16 0 0,00 399,16 Payment: Up to 07.12.2026',
];

/** Rows of a German wholesaler's invoice as read from a photo (Rechnung RE22606995, 03.11.2026). */
const PER_POSITION_INVOICE = [
  'Rechnung II Nr. RE22606995',
  'Datum: 03.11.2026',
  'Pos. Art-Nr. Artikel Bezeichnung Mge. Einh. St. E-Preis (€) Ges. Preis (€)',
  '1. 1676 Annam Jack Mackerel Tin 24x425g 60 24 7% 33,36 2.001,60',
  '2. 1993 My Africa Jack Mackerel Tin (Tomato) 60 24 7% 33,36 2.001,60',
  '24x425g',
  '3. 3500 Annam Dried Red Chilli 50x100g 5 50 7% 49,50 247,50',
  '4. 3568 Annam Ponni Boiled Rice 10kg 120 Stk 7% 12,50 1.500,00',
  '5. 1536 Maliban Cream Cracker 8x500g 5 8 7% 18,32 91,60',
  'Batch No',
  '6. 394 Maliban Cream Cracker 40x190g 5 40 7% 34,00 170,00',
  '7. 3501 Annam Dried Red Chilli 10x500g 5 10 7% 41,90 209,50',
  'Gesamt: Netto (€) MwSt in % MwSt. Brutto (€)',
  '6.221,80 7% 435,53 6.657,33',
  'Rechnungsbetrag 6.657,33',
];

describe('more invoice layouts (ADR 0058)', () => {
  it('reads packed lines as invoiced and by the piece, whichever the price belongs to', () => {
    const invoice = parseInvoice(PACKED_INVOICE);
    expect(invoice).toMatchObject({ number: '10163527', date: '07.11.2026', total: '399.16' });
    // Printed per piece: 48 × 2.51; as invoiced 4 cartons at 30.12.
    expect(invoice.lines[0]).toMatchObject({
      code: '10434',
      description: 'GOLDEN MORN 12x300GR',
      quantity: '4',
      unitPrice: '30.12',
      total: '120.48',
      checks: true,
      pack: { count: '4', per: '12', unit: 'CAR', pieces: '48', piecePrice: '2.51' },
    });
    // Printed per carton: 10 × 10.54; by the piece 400 at 0.2635.
    expect(invoice.lines[1]).toMatchObject({
      quantity: '10',
      unitPrice: '10.54',
      pack: { pieces: '400', piecePrice: '0.2635' },
      checks: true,
    });
    expect(invoice.lines.every((l) => l.checks)).toBe(true);
  });

  it('merges a free second line of the same product and skips transport and the like', () => {
    const invoice = parseInvoice(PACKED_INVOICE);
    expect(invoice.lines.map((l) => l.code)).toEqual(['10434', '8030', '1593', '9051']);
    // 5 cartons paid and 1 free: 6 cartons for 124.80.
    expect(invoice.lines[2]).toMatchObject({
      quantity: '6',
      unitPrice: '20.80',
      total: '124.80',
      pack: { count: '6', pieces: '144', piecePrice: '0.8667' },
    });
    expect(invoice.skipped).toEqual(['TRASPORTO', 'ORDER CONFIRMED']);
    expect(linesTotal(invoice.lines)).toBe('399.16');
  });

  it('reads a per-position invoice with pieces per pack, VAT and the net total', () => {
    const invoice = parseInvoice(PER_POSITION_INVOICE);
    expect(invoice).toMatchObject({ number: 'RE22606995', date: '03.11.2026', total: '6221.80' });
    expect(invoice.lines.map((l) => l.code)).toEqual([
      '1676',
      '1993',
      '3500',
      '3568',
      '1536',
      '394',
      '3501',
    ]);
    expect(invoice.lines[0]).toMatchObject({
      description: 'Annam Jack Mackerel Tin 24x425g',
      quantity: '60',
      unitPrice: '33.36',
      vatRate: '7',
      total: '2001.60',
      pack: { count: '60', per: '24', unit: null, pieces: '1440', piecePrice: '1.39' },
    });
    // Single pieces ("Stk") are not packs.
    expect(invoice.lines[3]).toMatchObject({ quantity: '120', unitPrice: '12.50' });
    expect(invoice.lines[3]!.pack).toBeUndefined();
    expect(invoice.lines.every((l) => l.checks)).toBe(true);
  });
});
