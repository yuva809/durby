import { CATALOG_IMPORT_MAX_ROWS, type ImportProductRow } from '@durby/shared';

/**
 * Reads a products CSV in the browser (docs/modules/catalog.md → Import): the api only gets rows.
 * RFC 4180 quoting, comma or semicolon separated (German Excel writes semicolons), UTF-8 with or
 * without BOM. No dependency: the format is small and fixed.
 */

/** The template's header row, also the canonical column names. */
export const PRODUCTS_CSV_TEMPLATE = 'category,name,price,tax_rate,description\n';

type Column = 'category' | 'name' | 'price' | 'taxRate' | 'description';

const COLUMN_NAMES: Record<string, Column> = {
  category: 'category',
  name: 'name',
  price: 'price',
  taxrate: 'taxRate',
  vat: 'taxRate',
  vatrate: 'taxRate',
  description: 'description',
};
const REQUIRED: readonly Column[] = ['category', 'name', 'price', 'taxRate'];

export type CsvProblem =
  | { kind: 'empty' }
  | { kind: 'missingColumns'; columns: Column[] }
  | { kind: 'tooManyRows'; max: number };

export type ParsedProductsCsv =
  { ok: true; rows: ImportProductRow[] } | { ok: false; problem: CsvProblem };

/** Splits CSV text into records of fields; quotes may contain separators, quotes and newlines. */
export function splitCsv(text: string, separator: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === separator) {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** The header's separator: whichever of `;` and `,` it uses more (outside quotes). */
function separatorOf(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const unquoted = header.replace(/"[^"]*"/g, '');
  const count = (c: string) => unquoted.split(c).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

/** `4,50` (German decimal comma) → `4.50`; anything else is left for the shared checker. */
function decimal(value: string): string {
  const v = value.trim();
  return /^\d+,\d{1,2}$/.test(v) ? v.replace(',', '.') : v;
}

export function parseProductsCsv(input: string): ParsedProductsCsv {
  const text = input.replace(/^\uFEFF/, '');
  const records = splitCsv(text, separatorOf(text)).filter((r) => r.some((f) => f.trim() !== ''));
  const [header, ...data] = records;
  if (!header || data.length === 0) return { ok: false, problem: { kind: 'empty' } };

  const index = new Map<Column, number>();
  header.forEach((name, i) => {
    const column =
      COLUMN_NAMES[
        name
          .trim()
          .toLowerCase()
          .replace(/[\s_-]/g, '')
      ];
    if (column && !index.has(column)) index.set(column, i);
  });
  const missing = REQUIRED.filter((c) => !index.has(c));
  if (missing.length > 0)
    return { ok: false, problem: { kind: 'missingColumns', columns: missing } };
  if (data.length > CATALOG_IMPORT_MAX_ROWS) {
    return { ok: false, problem: { kind: 'tooManyRows', max: CATALOG_IMPORT_MAX_ROWS } };
  }

  const cell = (record: string[], column: Column) => record[index.get(column)!] ?? '';
  const hasDescription = index.has('description');
  return {
    ok: true,
    rows: data.map((record) => ({
      category: cell(record, 'category').trim(),
      name: cell(record, 'name').trim(),
      price: decimal(cell(record, 'price')),
      taxRate: decimal(cell(record, 'taxRate')).replace(/%$/, '').trim(),
      ...(hasDescription && { description: cell(record, 'description').trim() }),
    })),
  };
}
