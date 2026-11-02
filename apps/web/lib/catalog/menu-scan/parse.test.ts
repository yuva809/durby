import { describe, expect, it } from 'vitest';
import { cleanName, normalizePrice, type OcrLine, parseMenu, splitPrices } from './parse';

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
