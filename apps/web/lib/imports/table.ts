import {
  IMPORT_MAX_ROWS,
  IMPORT_REQUIRED_COLUMNS,
  IMPORT_TEMPLATES,
  type ImportKind,
  type StockUnit,
  unitLookup,
} from '@durby/shared';
import { cellText, splitCsv } from '../catalog/import-file';

/**
 * Import Data in the browser (docs/platform/import.md, ADR 0044 step 4, ADR 0054): a CSV or Excel file becomes the
 * rows of one kind. CSV as in the products import: RFC 4180 quoting, comma or semicolon, UTF-8 with or without BOM.
 * Excel: the .xlsx workbook, read on the device. Headers are matched loosely ("Min quantity", "min_quantity" and
 * "MinQuantity" are one column); unknown columns are ignored.
 */

/** "Min quantity" → "minquantity". */
const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Template column → the row field it fills. */
const FIELD: Record<string, string> = {
  name: 'name',
  sku: 'sku',
  unit: 'unit',
  brand: 'brand',
  packsize: 'packSize',
  minquantity: 'minQuantity',
  saleprice: 'salePrice',
  warehouse: 'warehouse',
  item: 'item',
  quantity: 'quantity',
  unitcost: 'unitCost',
  code: 'code',
  phone: 'phone',
  email: 'email',
  address: 'address',
  note: 'note',
};

/** Other names people use for a column, per kind. */
const ALIASES: Readonly<Record<ImportKind, Record<string, string>>> = {
  categories: { category: 'name', categoryname: 'name' },
  items: {
    itemname: 'name',
    product: 'name',
    articleno: 'sku',
    marke: 'brand',
    pack: 'packSize',
    packung: 'packSize',
    gebinde: 'packSize',
    price: 'salePrice',
    minqty: 'minQuantity',
  },
  opening_stock: { qty: 'quantity', cost: 'unitCost', store: 'warehouse', sku: 'item' },
  customers: {
    customer: 'name',
    customercode: 'code',
    mobile: 'phone',
    tel: 'phone',
    mail: 'email',
  },
};

export type TableProblem =
  | { kind: 'empty' }
  | { kind: 'unreadable' }
  | { kind: 'missingColumns'; columns: string[] }
  | { kind: 'tooManyRows'; max: number };

export type ReadRows =
  { ok: true; rows: Record<string, string>[] } | { ok: false; problem: TableProblem };

/** The header's separator: whichever of `;` and `,` it uses more (outside quotes). */
function separatorOf(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const unquoted = header.replace(/"[^"]*"/g, '');
  const count = (c: string) => unquoted.split(c).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

/** `4,50` (German decimal comma) → `4.50` in number columns. */
const NUMERIC = new Set(['minQuantity', 'salePrice', 'quantity', 'unitCost']);
const decimal = (value: string) => {
  const v = value.trim();
  return /^\d+,\d{1,4}$/.test(v) ? v.replace(',', '.') : v;
};

/** The rows of a CSV file for one kind: every field present (empty when the cell is), blank lines skipped. */
export function readRows(kind: ImportKind, input: string): ReadRows {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return readTableRows(kind, splitCsv(text, separatorOf(text)));
}

/** An Excel file's name: these are read as a workbook, everything else as CSV text. */
export const isExcel = (fileName: string) => /\.xlsx$/i.test(fileName);

/**
 * The rows of an Excel workbook (.xlsx) for one kind: the sheet named like the kind ("Opening stock",
 * "opening_stock"), else the first. Numbers come as the text Excel stored, never as floats (rule 6).
 */
export async function readXlsxRows(kind: ImportKind, file: Blob): Promise<ReadRows> {
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    sheets = await readXlsxFile(file, { parseNumber: (text: string) => ({ number: text }) });
  } catch {
    return { ok: false, problem: { kind: 'unreadable' } };
  }
  const sheet = sheets.find((s) => normalize(s.sheet) === normalize(kind)) ?? sheets[0];
  if (!sheet) return { ok: false, problem: { kind: 'empty' } };
  return readTableRows(
    kind,
    sheet.data.map((row) => row.map(cellText)),
  );
}

/** The rows of a table (header row first) for one kind, from CSV or Excel alike. */
export function readTableRows(kind: ImportKind, table: readonly string[][]): ReadRows {
  const [header, ...records] = table;
  if (!header || header.every((h) => h.trim() === ''))
    return { ok: false, problem: { kind: 'empty' } };
  const columns = header.map((h) => {
    const n = normalize(h);
    return FIELD[n] ?? ALIASES[kind][n] ?? null;
  });
  const wanted = IMPORT_TEMPLATES[kind].map((c) => FIELD[normalize(c)]!);
  const missing = IMPORT_REQUIRED_COLUMNS[kind].filter(
    (c) => !columns.includes(FIELD[normalize(c)]!),
  );
  if (missing.length > 0)
    return { ok: false, problem: { kind: 'missingColumns', columns: missing } };
  const data = records.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (data.length === 0) return { ok: false, problem: { kind: 'empty' } };
  if (data.length > IMPORT_MAX_ROWS) {
    return { ok: false, problem: { kind: 'tooManyRows', max: IMPORT_MAX_ROWS } };
  }
  const rows = data.map((record) => {
    const row: Record<string, string> = Object.fromEntries(wanted.map((f) => [f, '']));
    columns.forEach((field, i) => {
      if (field && wanted.includes(field)) {
        const value = (record[i] ?? '').trim();
        row[field] = NUMERIC.has(field) ? decimal(value) : value;
      }
    });
    return row;
  });
  return { ok: true, rows };
}

/** The template file: the header row only. */
export const templateCsv = (kind: ImportKind): string => `${IMPORT_TEMPLATES[kind].join(',')}\r\n`;

/**
 * Stock item rows may name a unit by its code (`pc`) or by the name the organization sees for it (`Stück`, `Stk.`):
 * names are turned into codes before the rows are checked and sent. `labelOf` gives the shown name of each code;
 * a cell matching neither is left as it is, so the check reports it.
 */
export function withUnitCodes(
  rows: readonly Record<string, string>[],
  labelOf: (unit: StockUnit) => string,
): Record<string, string>[] {
  const unitOf = unitLookup(labelOf);
  return rows.map((row) => {
    const unit = row.unit === undefined ? undefined : unitOf(row.unit);
    return unit ? { ...row, unit } : { ...row };
  });
}
