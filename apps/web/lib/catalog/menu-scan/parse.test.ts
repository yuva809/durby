import { describe, expect, it } from 'vitest';
import {
  cleanName,
  joinRows,
  menuNumberOf,
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

  it('reads the item number before a name, digits only', () => {
    expect(menuNumberOf('01. Egg Hoppers')).toBe('01');
    expect(menuNumberOf('12) Devilled Chicken')).toBe('12');
    expect(menuNumberOf('(8 Naan')).toBe('8');
    expect(menuNumberOf('Watalappan')).toBeNull();
    expect(menuNumberOf('1dly')).toBeNull();
    // A leading zero read as the letter O; a name starting with O stays a name.
    expect(menuNumberOf('O4. ERAL VARUTHATHU')).toBe('04');
    expect(cleanName('O4. ERAL VARUTHATHU')).toBe('ERAL VARUTHATHU');
    expect(menuNumberOf('Onion Bhaji')).toBeNull();
    expect(cleanName('O2 Bar')).toBe('O2 Bar');
    expect(menuNumberOf('$7 Naan')).toBeNull();
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
    // Its own line's confidence (a well-read description doesn't change it); a second price is
    // kept in the description.
    expect(chicken.confidence).toBe(87);
    expect(menu[1]!.products[0]!.description).toBe('1600.00');
  });

  it('keeps products before the first heading in an unnamed category', () => {
    expect(parseMenu(lines('Espresso 2,50', 'Cappuccino 3,20'))).toEqual([
      {
        name: null,
        suspect: false,
        products: [
          expect.objectContaining({ name: 'Espresso', price: '2.50' }),
          expect.objectContaining({ name: 'Cappuccino', price: '3.20' }),
        ],
      },
    ]);
  });

  it('skips noise and headings without products', () => {
    expect(parseMenu(lines('***', 'DESSERTS', 'MAINS', 'Steak 24.90', '12'))).toEqual([
      { name: 'MAINS', suspect: false, products: [expect.objectContaining({ name: 'Steak' })] },
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

describe('menus read from screenshots', () => {
  /** A line at a position; `strip` is the column strip it was read in. */
  const at = (text: string, x0: number, y0: number, h = 22, strip = 0): OcrLine => ({
    text,
    confidence: 90,
    page: 1,
    strip,
    box: { x0, y0, x1: x0 + text.length * 12, y1: y0 + h },
  });
  const read = (page: OcrLine[]) => parseMenu(orderColumns(joinRows(page), 1000));
  const products = (page: OcrLine[]) =>
    read(page).flatMap((c) => c.products.map((p) => [p.name, p.price]));

  it('gives a price set level with the description to the name above it', () => {
    expect(
      products([
        at('ERAL VARUTHATHU (MITTEL-SCHARF)', 260, 100, 23),
        at('GEBRATENE GARNELEN UND GEMUESE', 260, 130, 15),
        at('11,90 €', 900, 126, 22),
        at('CHICKEN 65 (MITTEL-SCHARF)', 260, 200, 23),
        at('10,90 €', 900, 226, 22),
      ]),
    ).toEqual([
      ['ERAL VARUTHATHU (MITTEL-SCHARF)', '11.90'],
      ['CHICKEN 65 (MITTEL-SCHARF)', '10.90'],
    ]);
    expect(
      read([at('ERAL', 260, 100, 23), at('11,90 €', 900, 126, 22)])[0]?.products[0]?.description,
    ).toBe('');
  });

  it('gives the price to the numbered name above a description set under its text', () => {
    // The description starts under the name, right of the item number in front of it.
    expect(
      products([
        at('05. CHICKEN 65 (MITTEL-SCHARF)', 200, 100, 23),
        at('HÜHNERBRUST MARINIERT MIT GEWÜRZEN', 245, 130, 15),
        at('10,90 €', 900, 126, 22),
        at('06. CHICKEN VARUTHATHU (MITTEL-SCHARF)', 200, 200, 23),
        at('GEBRATENES HÄHNCHEN UND GEMÜSE', 245, 230, 15),
        at('10,90 €', 900, 226, 22),
      ]),
    ).toEqual([
      ['CHICKEN 65 (MITTEL-SCHARF)', '10.90'],
      ['CHICKEN VARUTHATHU (MITTEL-SCHARF)', '10.90'],
    ]);
  });

  it('joins a price column read as its own strip to the name, not to the item number', () => {
    expect(
      products([
        at('16', 238, 100, 16, 0),
        at('BEILAGE SALAT', 277, 98, 20, 1),
        at('6,90 €', 940, 126, 16, 2),
        at('17.', 238, 220, 16, 0),
        at('ALOO CHANNA CHAT', 276, 218, 20, 1),
        at('6,90 €', 940, 246, 16, 2),
      ]),
    ).toEqual([
      ['BEILAGE SALAT', '6.90'],
      ['ALOO CHANNA CHAT', '6.90'],
    ]);
  });

  it('keeps a name that wraps onto two lines whole', () => {
    expect(
      products([
        at('MEEN MOILEE (MILD)', 277, 100, 23),
        at('21,90 €', 934, 100, 23),
        at('MEEN PULI KOZHAMBU (SAUER & MITTEL-', 277, 190, 23),
        at('SCHARF)', 277, 215, 23),
        at('21,90 €', 934, 215, 23),
      ]),
    ).toEqual([
      ['MEEN MOILEE (MILD)', '21.90'],
      ['MEEN PULI KOZHAMBU (SAUER & MITTEL-SCHARF)', '21.90'],
    ]);
  });

  it('leaves out the screen around the menu', () => {
    expect(
      products([
        at('08:14', 60, 10),
        at('Menu Page 3', 100, 60),
        at('Main Menu', 100, 90),
        at('Soup 5,50 €', 100, 140),
        at('bay-leaf.eu', 100, 400),
      ]),
    ).toEqual([['Soup', '5.50']]);
  });

  it('drops a word fragment with a whole price on a menu priced with cents, however sure OCR was', () => {
    expect(
      products([
        at('age 3', 100, 60),
        at('Butter Chicken 18,90', 100, 140),
        at('Chicken Tikka 18,90', 100, 180),
        at('Naan 3,90', 100, 220),
        at('Garlic Naan 4,50', 100, 260),
      ]).map(([name]) => name),
    ).toEqual(['Butter Chicken', 'Chicken Tikka', 'Naan', 'Garlic Naan']);
  });

  it('cleans a half-read item number off a name', () => {
    expect(cleanName('. ERAL VARUTHATHU')).toBe('ERAL VARUTHATHU');
  });

  it('keeps the item number of a product (ADR 0029)', () => {
    const numbered = read([
      at('MAINS', 100, 40, 30),
      at('12 Butter Chicken 12,90', 100, 100),
      at('7 2.Poori 4,50', 100, 140),
      at('Naan 3,90', 100, 180),
      at('¢7 Garlic Naan 4,50', 100, 220),
    ]).flatMap((c) => c.products);
    expect(numbered.map((p) => [p.name, p.number])).toEqual([
      ['Butter Chicken', '12'],
      ['Poori', '72'],
      ['Naan', undefined],
      // A digit read as ¢: better no number than a wrong one.
      ['Garlic Naan', undefined],
    ]);
  });
});
