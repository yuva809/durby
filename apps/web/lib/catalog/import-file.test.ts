import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkImportRows } from '@durby/shared';
import { describe, expect, it } from 'vitest';
import {
  cellText,
  parseProductsCsv,
  parseProductsXlsx,
  percentFraction,
  PRODUCTS_CSV_TEMPLATE,
  splitCsv,
  tidyNumber,
} from './import-file';

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

describe('Excel numbers as text (no JS number math, rule 6)', () => {
  it.each([
    ['24.9', '24.9'],
    ['7', '7'],
    ['7.9000000000000004', '7.9'],
    ['24.899999999999999', '24.9'],
    ['4.555', '4.555'],
    ['0.07', '0.07'],
    ['abc', 'abc'],
  ])('tidyNumber(%s) → %s', (input, expected) => {
    expect(tidyNumber(input)).toBe(expected);
  });

  it.each([
    ['0.07', '7'],
    ['0.19', '19'],
    ['0.075', '7.5'],
    ['7', '7'],
    ['19.5', '19.5'],
    ['0', '0'],
  ])('percentFraction(%s) → %s', (input, expected) => {
    expect(percentFraction(input)).toBe(expected);
  });

  it('turns cells into text', () => {
    expect(cellText({ number: '4.5' })).toBe('4.5');
    expect(cellText(' Soju ')).toBe(' Soju ');
    expect(cellText(null)).toBe('');
    expect(cellText(true)).toBe('true');
    expect(cellText(new Date('2026-11-02T00:00:00Z'))).toBe('2026-11-02');
  });
});

describe('parseProductsXlsx', () => {
  it('reads the sample workbook from docs/samples: its products sheet, 12 clean rows', async () => {
    const bytes = readFileSync(
      fileURLToPath(
        new URL('../../../../docs/samples/products-import-template.xlsx', import.meta.url),
      ),
    );
    const parsed = await parseProductsXlsx(new Blob([bytes]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toHaveLength(12);
    expect(parsed.rows[0]).toEqual({
      category: 'Starters',
      name: 'Kimchi',
      price: '4.5',
      taxRate: '7',
      description: 'House-made, fermented 3 weeks',
    });
    expect(checkImportRows(parsed.rows)).toEqual([]);
  });

  it('says so when the file is no workbook', async () => {
    expect(await parseProductsXlsx(new Blob(['not a zip']))).toEqual({
      ok: false,
      problem: { kind: 'unreadable' },
    });
  });
});
