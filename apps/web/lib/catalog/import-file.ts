import { CATALOG_IMPORT_MAX_ROWS, type ImportProductRow } from '@durby/shared';

/**
 * Reads a products file in the browser (docs/modules/catalog.md → Import): the api only gets rows.
 * CSV: RFC 4180 quoting, comma or semicolon separated (German Excel writes semicolons), UTF-8 with
 * or without BOM, no dependency. Excel (.xlsx): `read-excel-file`, loaded only when needed. Both
 * end in `rowsFromTable`, so headers, aliases and limits are the same.
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
  | { kind: 'unreadable' }
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
  return rowsFromTable(splitCsv(text, separatorOf(text)));
}

/**
 * The first row names the columns, the rest are products (blank rows skipped): the part both file
 * formats share.
 */
export function rowsFromTable(table: string[][]): ParsedProductsCsv {
  const records = table.filter((r) => r.some((f) => f.trim() !== ''));
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

/** The sheet `products` if the workbook has one (the template's), else its first sheet. */
const SHEET = 'products';

/**
 * An Excel workbook's products. Numbers arrive as the text Excel stored (`parseNumber`), never as
 * JS numbers (rule 6): float noise from Excel (`7.9000000000000004`) is rounded away by text, a
 * VAT rate formatted as a percentage (stored `0.07`) becomes `7`.
 */
export async function parseProductsXlsx(file: Blob): Promise<ParsedProductsCsv> {
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    sheets = await readXlsxFile(file, { parseNumber: (text: string) => ({ number: text }) });
  } catch {
    return { ok: false, problem: { kind: 'unreadable' } };
  }
  const sheet = sheets.find((s) => s.sheet.trim().toLowerCase() === SHEET) ?? sheets[0];
  if (!sheet) return { ok: false, problem: { kind: 'empty' } };
  const parsed = rowsFromTable(sheet.data.map((row) => row.map(cellText)));
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    rows: parsed.rows.map((row) => ({ ...row, taxRate: percentFraction(row.taxRate) })),
  };
}

/** One cell as text: numbers by their stored text (tidied), dates as ISO dates, the rest as is. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'number' in value) {
    return typeof value.number === 'string' ? tidyNumber(value.number) : '';
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value;
  return typeof value === 'boolean' ? String(value) : '';
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * `7.9000000000000004` → `7.9`: rounds a stored number to 10 decimals by text (BigInt), then drops
 * trailing zeros. Real extra decimals (`4.555`) stay and fail the price check, as they should.
 */
export function tidyNumber(text: string): string {
  const match = DECIMAL.exec(text.trim());
  if (!match) return text.trim();
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length <= 10) return stripZeros(whole, fraction);
  const scaled = BigInt(whole + fraction.slice(0, 10)) + (Number(fraction[10]) >= 5 ? 1n : 0n);
  const digits = scaled.toString().padStart(11, '0');
  return stripZeros(digits.slice(0, -10), digits.slice(-10));
}

/** A VAT rate stored as a fraction (Excel percent format: `0.07` for 7 %) becomes percent text. */
export function percentFraction(text: string): string {
  const match = DECIMAL.exec(text);
  if (!match || match[1] !== '0' || !match[2] || /^0+$/.test(match[2])) return text;
  const fraction = match[2].padEnd(2, '0');
  return stripZeros(fraction.slice(0, 2).replace(/^0(?=\d)/, ''), fraction.slice(2));
}

function stripZeros(whole: string, fraction: string): string {
  const f = fraction.replace(/0+$/, '');
  const w = whole.replace(/^0+(?=\d)/, '') || '0';
  return f ? `${w}.${f}` : w;
}
