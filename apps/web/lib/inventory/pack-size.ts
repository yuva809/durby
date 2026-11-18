import type { StockUnit } from '@durby/shared';

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

const UNITS: Readonly<Record<string, StockUnit>> = {
  kg: 'kg',
  kgs: 'kg',
  g: 'g',
  gr: 'g',
  grs: 'g',
  gram: 'g',
  grams: 'g',
  l: 'l',
  ltr: 'l',
  lt: 'l',
  ml: 'ml',
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
  const size = pack.size ? `${pack.size.replace(/\.?0+$/, '')} ${pack.unit ?? ''}`.trim() : null;
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
