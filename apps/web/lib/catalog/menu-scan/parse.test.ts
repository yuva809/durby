import { describe, expect, it } from 'vitest';
import {
  cleanName,
  normalizePrice,
  type OcrLine,
  type OcrWord,
  orderColumns,
  parseMenu,
  segmentLine,
  splitPrices,
} from './parse';

const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
const lines = (...texts: string[]): OcrLine[] =>
  texts.map((text, i) => ({ text, confidence: 90 - i, page: 1, box }));

describe('normalizePrice', () => {
  it.each([
    ['1,500.00', '1500.00'],
    ['1.500,00', '1500.00'],
    ['1 500,00', '1500.00'],
    ['12,50', '12.50'],
    ['12.5', '12.50'],
    ['12', '12.00'],
    ['€12,90', '12.90'],
    ['12,90€', '12.90'],
    ['Rs.450', '450.00'],
    ['1,500', '1500.00'],
    ['0.50', '0.50'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePrice(raw)).toBe(expected);
  });

  it.each(['0773566765', 'abc', '12.345.6', '', '012'])('%s is no price', (raw) => {
    expect(normalizePrice(raw)).toBeNull();
  });
});

describe('splitPrices and cleanName', () => {
  it('reads trailing prices with separate currency marks', () => {
    expect(splitPrices('Chicken Kottu Rs. 1,200.00')).toEqual({
      name: 'Chicken Kottu',
      prices: ['1200.00'],
    });
    expect(splitPrices('Fried Rice 900.00 1,400.00')).toEqual({
      name: 'Fried Rice',
      prices: ['900.00', '1400.00'],
    });
    expect(splitPrices('Soju 7,00 €')).toEqual({ name: 'Soju', prices: ['7.00'] });
    expect(splitPrices('Call us 0773566765')).toEqual({ name: 'Call us 0773566765', prices: [] });
  });

  it('drops item numbers, dot leaders and trailing separators', () => {
    expect(cleanName('01. Egg Hoppers ........')).toBe('Egg Hoppers');
    expect(cleanName('12) Devilled Chicken -')).toBe('Devilled Chicken');
    expect(cleanName('• Watalappan')).toBe('Watalappan');
  });
});

describe('parseMenu', () => {
  it('builds categories from headings, products from priced lines, descriptions from the rest', () => {
    const menu = parseMenu(
      lines(
        'BAY LEAF',
        'Ala Carte',
        'RICE & CURRY',
        'Chicken Rice & Curry ........ 1,100.00',
        'with dhal, potato and papadam',
        'Fish Rice & Curry 1,200.00',
        'Kottu',
        '01. Chicken Kottu 1,300.00 1,600.00',
        'Cheese Kottu 1,500.00',
        'BEVERAGES',
        'Ginger Beer 350.00',
        'Call 0773566765',
      ),
    );
    expect(menu.map((c) => [c.name, c.products.map((p) => [p.name, p.price])])).toEqual([
      [
        'RICE & CURRY',
        [
          ['Chicken Rice & Curry', '1100.00'],
          ['Fish Rice & Curry', '1200.00'],
        ],
      ],
      [
        'Kottu',
        [
          ['Chicken Kottu', '1300.00'],
          ['Cheese Kottu', '1500.00'],
        ],
      ],
      ['BEVERAGES', [['Ginger Beer', '350.00']]],
    ]);
    const chicken = menu[0]!.products[0]!;
    expect(chicken.description).toBe('with dhal, potato and papadam');
    // The lowest confidence of its lines; a second price is kept in the description.
    expect(chicken.confidence).toBe(86);
    expect(menu[1]!.products[0]!.description).toBe('1600.00');
  });

  it('keeps products before the first heading in an unnamed category', () => {
    expect(parseMenu(lines('Espresso 2,50', 'Cappuccino 3,20'))).toEqual([
      {
        name: null,
        products: [
          expect.objectContaining({ name: 'Espresso', price: '2.50' }),
          expect.objectContaining({ name: 'Cappuccino', price: '3.20' }),
        ],
      },
    ]);
  });

  it('skips noise and headings without products', () => {
    expect(parseMenu(lines('***', 'DESSERTS', 'MAINS', 'Steak 24.90', '12'))).toEqual([
      { name: 'MAINS', products: [expect.objectContaining({ name: 'Steak' })] },
    ]);
  });
});

/** Words on one line 30 px high, each starting at the given x and 12 px per character wide. */
const words = (...parts: [string, number][]): OcrWord[] =>
  parts.map(([text, x0]) => ({
    text,
    confidence: 90,
    box: { x0, y0: 100, x1: x0 + text.length * 12, y1: 130 },
  }));

describe('segmentLine and orderColumns', () => {
  it('splits a line read across two columns, but keeps a far-right price with its name', () => {
    const line = words(
      ['Chicken', 70],
      ['Soup', 166],
      ['650.00', 640],
      ['Devilled', 850],
      ['Prawns', 956],
      ['1,950.00', 1420],
    );
    expect(segmentLine(line, 1).map((l) => l.text)).toEqual([
      'Chicken Soup 650.00',
      'Devilled Prawns 1,950.00',
    ]);
    expect(segmentLine(line, 1)[1]!.box).toEqual({ x0: 850, y0: 100, x1: 1516, y1: 130 });
  });

  it('splits two headings on one line and keeps "Rs. 450" together', () => {
    expect(segmentLine(words(['SOUPS', 60], ['DEVILLED', 840]), 1).map((l) => l.text)).toEqual([
      'SOUPS',
      'DEVILLED',
    ]);
    expect(
      segmentLine(words(['Tea', 60], ['Rs.', 400], ['450', 450]), 1).map((l) => l.text),
    ).toEqual(['Tea Rs. 450']);
  });

  it('reads column by column, top to bottom; a lone title joins the first column', () => {
    const at = (text: string, x0: number, y0: number): OcrLine => ({
      text,
      confidence: 90,
      page: 1,
      box: { x0, y0, x1: x0 + 300, y1: y0 + 30 },
    });
    const ordered = orderColumns(
      [
        at('Bay Leaf', 400, 10),
        at('SOUPS', 60, 100),
        at('DRINKS', 840, 100),
        at('Soup 650.00', 70, 140),
        at('Lime Juice 350.00', 850, 140),
        at('Kottu 1,200.00', 70, 180),
        at('Lassi 550.00', 850, 180),
      ],
      1600,
    );
    expect(ordered.map((l) => l.text)).toEqual([
      'Bay Leaf',
      'SOUPS',
      'Soup 650.00',
      'Kottu 1,200.00',
      'DRINKS',
      'Lime Juice 350.00',
      'Lassi 550.00',
    ]);
  });
});
