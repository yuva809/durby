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
