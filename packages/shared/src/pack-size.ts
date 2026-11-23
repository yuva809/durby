import { STOCK_UNITS, type StockUnit } from './api/inventory';

/**
 * Pack sizes (ADR 0055): "12 x 500 g" is 12 packs of 500 g. Read from an invoice line's description so the review
 * starts filled in; shown back as "12 × 500 g". Count and size are text as typed (decimal strings, rule 6).
 */
export interface PackSize {
  count: string;
  size: string;
  unit: StockUnit | '';
}

export const EMPTY_PACK: PackSize = { count: '', size: '', unit: '' };

/** Short forms of the weight and volume units that invoices and spreadsheets use. */
const UNITS: Readonly<Record<string, StockUnit>> = {
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  g: 'g',
  gr: 'g',
  grs: 'g',
  grm: 'g',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
  l: 'l',
  ltr: 'l',
  lt: 'l',
  litre: 'l',
  liter: 'l',
  ml: 'ml',
  mls: 'ml',
  pcs: 'pc',
  piece: 'pc',
  pieces: 'pc',
};

const AMOUNT = String.raw`(\d{1,6}(?:[.,]\d{1,3})?)\s*(kgs?|grams?|grs?|g|ltr|lt|l|ml)\b`;
/** "5 x 2kg", "12×500 g": count, size, unit. */
const COUNTED = new RegExp(String.raw`(?<![\d.,])(\d{1,5})\s*[x×*]\s*` + AMOUNT, 'i');
/** "4kg", not part of a range ("800-1000gr") or a longer number. */
const SINGLE = new RegExp(String.raw`(?<![\d.,\-–])` + AMOUNT + String.raw`(?![\-–]\d)`, 'gi');

const decimal = (value: string) => value.replace(',', '.');

/** The pack size a description names: "N x size unit" first, else a lone "size unit"; null when none. */
export function parsePackSize(text: string): PackSize | null {
  const counted = COUNTED.exec(text);
  if (counted) {
    const [, count, size, unit] = counted;
    return { count: count!, size: decimal(size!), unit: UNITS[unit!.toLowerCase()] ?? '' };
  }
  const singles = [...text.matchAll(SINGLE)];
  const last = singles.at(-1);
  if (!last) return null;
  return { count: '', size: decimal(last[1]!), unit: UNITS[last[2]!.toLowerCase()] ?? '' };
}

/** "5 × 2 kg", "4 kg", "12 ×", or '' when nothing is set. */
export function formatPackSize(pack: {
  count: string | number | null;
  size: string | null;
  unit: string | null;
}): string {
  const count = pack.count === null || pack.count === '' ? null : String(pack.count);
  const size = pack.size
    ? `${pack.size.includes('.') ? pack.size.replace(/\.?0+$/, '') : pack.size} ${pack.unit ?? ''}`.trim()
    : null;
  if (count && size) return `${count} × ${size}`;
  if (size) return size;
  if (count) return `${count} ×`;
  return '';
}

export type PackProblem = 'count' | 'size' | 'unit';

/** What keeps a pack size from saving: a whole count 1–100000, a size above 0 (3 decimals) with its unit. */
export function packProblems(pack: PackSize): PackProblem[] {
  const problems: PackProblem[] = [];
  const count = pack.count.trim();
  if (count !== '' && !(/^\d{1,6}$/.test(count) && Number(count) >= 1 && Number(count) <= 100_000))
    problems.push('count');
  const size = decimal(pack.size.trim());
  if (size !== '' && !(/^\d{1,10}(\.\d{1,3})?$/.test(size) && Number(size) > 0))
    problems.push('size');
  if ((size === '') !== (pack.unit === '')) problems.push('unit');
  return problems;
}

/** The api's fields for a pack size (only what is set; call when packProblems finds none). */
export function packFields(pack: PackSize): {
  packCount?: number;
  packSize?: string;
  packUnit?: StockUnit;
} {
  const count = pack.count.trim();
  const size = decimal(pack.size.trim());
  return {
    ...(count ? { packCount: Number(count) } : {}),
    ...(size && pack.unit ? { packSize: size, packUnit: pack.unit } : {}),
  };
}

/** "Stk." → "stk": case, spaces and trailing dots ignored. */
export const unitKey = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '');

/** The shown name(s) of a unit: one label, or several (the same unit in more than one language). */
export type UnitLabels = (unit: StockUnit) => string | readonly string[];

/** Unit words → unit codes: the name an organization shows for each unit, plus the codes and short forms. */
export type UnitLookup = (word: string) => StockUnit | undefined;

/**
 * Looks a unit up by its code or the name `labelOf` gives it (the organization's label, e.g. "Stück", "Stk.").
 * A code (and a short form like "ltr") always means itself, even if another unit's name reads the same.
 */
export function unitLookup(labelOf: UnitLabels): UnitLookup {
  const codes = new Map<string, StockUnit>();
  for (const unit of STOCK_UNITS) {
    for (const name of [labelOf(unit)].flat()) {
      const label = unitKey(name);
      if (label && !codes.has(label)) codes.set(label, unit);
    }
  }
  for (const [short, unit] of Object.entries(UNITS)) codes.set(short, unit);
  for (const unit of STOCK_UNITS) codes.set(unit, unit);
  return (word) => codes.get(unitKey(word));
}

/** "12 x 500 ml", "12×400 ML", "1,5 ltr", "5kg": count (optional), size, unit word (a shown name or code). */
const CELL = /^(?:(\d{1,6})\s*[x×*]\s*)?(\d{1,10}(?:[.,]\d+)?)\s*([^\d\s.,*×][^\d]*)$/i;

/**
 * The pack size of one spreadsheet cell: the whole cell must be a pack size (unlike `parsePackSize`, which finds one
 * inside an invoice description). A bare whole number, "Pack of 6" or a whole number of pieces ("50 pcs") is the count alone. Null when it is neither;
 * the result still goes through `packProblems`.
 */
export function parsePackCell(text: string, unitOf: UnitLookup): PackSize | null {
  const cell = text.trim();
  const count = /^(?:pack\s+of\s+)?(\d{1,6})$/i.exec(cell);
  if (count) return { count: count[1]!, size: '', unit: '' };
  const match = CELL.exec(cell);
  if (!match) return null;
  const unit = unitOf(match[3]!);
  if (!unit) return null;
  const size = decimal(match[2]!);
  // "50 pcs": a whole number of pieces and no "x" is how many are in the pack, not a size.
  if (unit === 'pc' && match[1] === undefined && /^\d{1,6}$/.test(size)) {
    return { count: size, size: '', unit: '' };
  }
  return { count: match[1] ?? '', size, unit };
}
