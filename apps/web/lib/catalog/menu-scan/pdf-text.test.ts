import { describe, expect, it } from 'vitest';
import fixture from './fixtures/menu-pdf-text.json';
import { hasText, parseTextPage, parseTextPages, type TextItem } from './pdf-text';

/** The fixture: pages 2–26 of a real 26-page digital menu (text runs as pdf.js gives them). */
const pages = fixture.pages.map((p, i) => ({ number: i + 2, items: p.items }));
const PRICE = /^(?:€\s?)?\d{1,4}(?:[.,]\d{3})*[.,]\d{2}\s?(?:€|EUR)?$/i;

describe('parseTextPages on a 26-page digital menu', () => {
  const categories = parseTextPages(pages);
  const products = categories.flatMap((c) => c.products.map((p) => ({ ...p, category: c.name })));
  const find = (name: string) => products.filter((p) => p.name === name);

  it('uses every price printed on the menu exactly once', () => {
    const printed = pages.flatMap((p) =>
      p.items.filter((i) => !i.rotated && PRICE.test(i.text.trim())),
    );
    expect(products).toHaveLength(printed.length);
    expect(products.every((p) => p.confidence === 100 && p.name.length > 0)).toBe(true);
  });

  it('takes each page heading as the category, in menu order', () => {
    expect(categories.map((c) => c.name)).toEqual([
      'Suppe',
      'Vorspeisen-FLEISH',
      'Vorspeisen-VEG',
      'Salat',
      'Dosai',
      'HAUPTGERICHT - vegetarisch',
      'HAUPTGERICHT - Vegan',
      'HAUPTGERICHT - Meeresfrüchte',
      'HAUPTGERICHT - Hähnchen',
      'HAUPTGERICHT - Lamm',
      'BIRYANI',
      'TANDOORI-SPEZIALITÄTEN',
      'BROT',
      'DESSERTS',
      'WOCHENEND-SPEZIAL',
      'Alkoholfreie',
      'Softgetränke',
      'Saft & Schorle',
      'Aperitifs',
      'Biere',
      'Spirituosen',
      'Weißwein',
      'Rotwein',
      'Tee & Cafe',
    ]);
  });

  it('reads names over two lines, descriptions and prices exactly as printed', () => {
    expect(find('Thakkali Rasam (Mittel-Scharf, Vegan)')).toEqual([
      expect.objectContaining({
        price: '6.90',
        description: 'Tomaten, Kräutern, gemahlenen Gewürzen und Curryblättern.',
        category: 'Suppe',
      }),
    ]);
    expect(find('Chicken Tikka Masala(Mild)')).toEqual([
      expect.objectContaining({
        price: '18.90',
        description: 'Hähnchen in cremiger, würziger Tomaten-Masala-Soße',
      }),
    ]);
    expect(find('Gulab Jamun')[0]).toMatchObject({
      price: '5.90',
      description: 'Frittierte Milchkugeln, getränkt in Rosen-Kardamom- Zuckersirup',
    });
    expect(find('Wolfenweiler Müller - Thurgau 0,4l')[0]?.price).toBe('9.60');
    expect(find('Moru')[0]).toMatchObject({ price: '4.90', category: 'Alkoholfreie' });
  });

  it('names drinks with their volume and splits two price columns into two products', () => {
    expect(find('Coca-Cola 0,4l')[0]?.price).toBe('3.90');
    expect(find('Wasser Still/Medium 0,25l')[0]?.price).toBe('3.10');
    expect(find('Indien Sula Weiß Wein 0,2l')[0]?.price).toBe('6.00');
    expect(find('Indien Sula Weiß Wein 0,4l')[0]?.price).toBe('12.00');
    // Only a 0,4l price is printed for the spritzer.
    expect(find('Indien Sula. Weiß Wein Schorle 0,4l')[0]?.price).toBe('4.20');
    expect(find('Pils 0,33l')[0]?.price).toBe('3.80');
    expect(find('Radler 0,5l')[0]?.price).toBe('4.50');
    expect(find('Gin-Tonic 4cl')[0]?.price).toBe('13.00');
  });
});

describe('parseTextPage', () => {
  const item = (text: string, x: number, y: number, size: number, rotated = false): TextItem => ({
    text,
    x,
    y,
    width: text.length * size * 0.5,
    size,
    rotated,
  });

  it('works without item numbers and carries the heading over to the next page', () => {
    const first = parseTextPage(
      [
        item('Starters', 50, 40, 40),
        item('Spring Rolls', 100, 100, 20),
        item('(vegan)', 100, 122, 20),
        item('Crispy rolls with vegetables', 100, 140, 14),
        item('5,50 €', 400, 140, 14),
        item('Samosa', 100, 200, 20),
        item('4,90 €', 400, 200, 14),
      ],
      1,
      null,
    );
    expect(first.categories).toEqual([
      {
        name: 'Starters',
        suspect: false,
        products: [
          expect.objectContaining({
            name: 'Spring Rolls (vegan)',
            description: 'Crispy rolls with vegetables',
            price: '5.50',
          }),
          expect.objectContaining({ name: 'Samosa', description: '', price: '4.90' }),
        ],
      },
    ]);
    const next = parseTextPage(
      [item('Pakora', 100, 100, 20), item('Fritters', 100, 120, 14), item('6,90 €', 400, 100, 14)],
      2,
      first.heading,
    );
    expect(next.categories[0]).toMatchObject({ name: 'Starters', products: [{ name: 'Pakora' }] });
  });

  it('tells text pages from scanned images', () => {
    expect(
      hasText([item('Menu', 0, 0, 20), item('Soup', 0, 20, 20), item('4,50', 0, 40, 20)]),
    ).toBe(true);
    expect(hasText([item(' ', 0, 0, 20)])).toBe(false);
  });
});
