import { describe, expect, it } from 'vitest';
import { parseProductsCsv, PRODUCTS_CSV_TEMPLATE, splitCsv } from './csv';

describe('splitCsv', () => {
  it('follows RFC 4180 quoting, also across lines', () => {
    expect(splitCsv('a,"b,c","say ""hi"""\r\n1,"two\nlines",3', ',')).toEqual([
      ['a', 'b,c', 'say "hi"'],
      ['1', 'two\nlines', '3'],
    ]);
  });
});

describe('parseProductsCsv', () => {
  it('reads the template columns in any order and case', () => {
    expect(
      parseProductsCsv(
        'Name,Category,Tax_Rate,Price,Description\nSoju,Drinks,19,7.00,"Cold, 360 ml"\n',
      ),
    ).toEqual({
      ok: true,
      rows: [
        {
          category: 'Drinks',
          name: 'Soju',
          price: '7.00',
          taxRate: '19',
          description: 'Cold, 360 ml',
        },
      ],
    });
  });

  it('reads German Excel exports: semicolons, decimal commas, BOM, VAT column, % sign', () => {
    expect(
      parseProductsCsv('\uFEFFKategorie;category;name;price;VAT\nx;Starters;Kimchi;4,50;7 %\n\n'),
    ).toEqual({
      ok: true,
      rows: [{ category: 'Starters', name: 'Kimchi', price: '4.50', taxRate: '7' }],
    });
  });

  it('leaves out description when the file has no such column', () => {
    const parsed = parseProductsCsv('category,name,price,tax_rate\nBBQ,So-Galbi,24.90,7');
    expect(parsed.ok && parsed.rows[0]).toEqual({
      category: 'BBQ',
      name: 'So-Galbi',
      price: '24.90',
      taxRate: '7',
    });
  });

  it('reports an empty file, missing columns and too many rows', () => {
    expect(parseProductsCsv(PRODUCTS_CSV_TEMPLATE)).toEqual({
      ok: false,
      problem: { kind: 'empty' },
    });
    expect(parseProductsCsv('category,name\nA,B')).toEqual({
      ok: false,
      problem: { kind: 'missingColumns', columns: ['price', 'taxRate'] },
    });
    const many = `category,name,price,tax_rate\n${'A,B,1,7\n'.repeat(1001)}`;
    expect(parseProductsCsv(many)).toEqual({
      ok: false,
      problem: { kind: 'tooManyRows', max: 1000 },
    });
  });
});
