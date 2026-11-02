/**
 * OCR lines of a menu → categories with products (docs/modules/catalog.md → Menu scan). Pure: the
 * OCR engine and the review board are elsewhere. Prices stay text from start to end (rule 6): a
 * menu's `1,500.00`, `1.500,00`, `12,50` or `12` become `1500.00`, `1500.00`, `12.50`, `12.00`
 * by string rules only.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One line as the OCR engine read it, in reading order. */
export interface OcrLine {
  text: string;
  /** 0–100. */
  confidence: number;
  page: number;
  box: Box;
}

export interface ParsedProduct {
  name: string;
  /** Decimal text with two places, e.g. `1500.00`. */
  price: string;
  description: string;
  /** The lowest confidence of the lines it came from (0–100). */
  confidence: number;
  source: { page: number; box: Box };
}

export interface ParsedCategory {
  /** null: products before the first heading (the board names them "Uncategorized"). */
  name: string | null;
  products: ParsedProduct[];
}

/** A menu's price can't be millions: longer digit runs are phone numbers, dates or codes. */
const MAX_PRICE_DIGITS = 7;
const MAX_HEADING_LENGTH = 40;
const CURRENCY = '(?:€|\\$|£|eur|euro|usd|rs\\.?|lkr|inr|₹|/-)';
const NUMBER = '\\d{1,3}(?:[.,\\s]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
const PRICE_TOKEN = new RegExp(`^${CURRENCY}?(${NUMBER})${CURRENCY}?$`, 'i');
const CURRENCY_ONLY = new RegExp(`^${CURRENCY}$`, 'i');

/**
 * A menu price → decimal text with two places, or null when it isn't one. The last `.` or `,`
 * followed by one or two digits is the decimal mark; other separators group thousands.
 */
export function normalizePrice(raw: string): string | null {
  const match = PRICE_TOKEN.exec(raw.trim().replace(/\s+/g, ' '));
  if (!match) return null;
  const digits = match[1]!.replace(/\s/g, '');
  const decimal = /[.,](\d{1,2})$/.exec(digits);
  const grouped = decimal ? digits.slice(0, -decimal[0].length) : digits;
  // Thousands and decimals can't use the same mark (`12.345.6` is no price, `12.345,60` is).
  if (decimal && grouped.includes(decimal[0][0]!)) return null;
  const whole = grouped.replace(/[.,]/g, '');
  if (!/^\d+$/.test(whole)) return null;
  const integer = whole.replace(/^0+(?=\d)/, '');
  if (integer.length > MAX_PRICE_DIGITS || (integer !== '0' && whole.startsWith('0'))) return null;
  return `${integer}.${(decimal?.[1] ?? '').padEnd(2, '0')}`;
}

/** Splits a line into its name and the prices at its end (`Kottu 1,200.00 1,500.00`). */
export function splitPrices(text: string): { name: string; prices: string[] } {
  const tokens = text.trim().split(/\s+/);
  const prices: string[] = [];
  // Rejoin "1 500,00" style groups and "Rs. 450" before reading from the end.
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1]!;
    if (CURRENCY_ONLY.test(last)) {
      tokens.pop();
      continue;
    }
    const price = normalizePrice(last);
    if (price === null) break;
    tokens.pop();
    if (tokens.length > 0 && CURRENCY_ONLY.test(tokens[tokens.length - 1]!)) tokens.pop();
    prices.unshift(price);
  }
  return { name: tokens.join(' '), prices };
}

/** Item numbers, dot leaders and trailing separators off a product name. */
export function cleanName(text: string): string {
  return text
    .replace(/^\s*(?:#?\d{1,3}[.):-]?|[•*·-])\s+/, '')
    .replace(/[.·…_]{2,}/g, ' ')
    .replace(/[\s:|–—-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const letters = (text: string) => text.replace(/[^\p{L}]/gu, '');

function isMostlyUppercase(text: string): boolean {
  const l = letters(text);
  if (l.length < 3) return false;
  const upper = l.replace(/[^\p{Lu}]/gu, '').length;
  return upper / l.length >= 0.7;
}

function isNoise(text: string): boolean {
  return letters(text).length < 2;
}

/**
 * The menu's categories and products. A line ending in a price is a product; an unpriced line is a
 * heading when it is short and either mostly uppercase or followed by a priced line, otherwise the
 * description of the product above it.
 */
export function parseMenu(lines: readonly OcrLine[]): ParsedCategory[] {
  const categories: ParsedCategory[] = [];
  let current: ParsedCategory | null = null;
  let lastProduct: ParsedProduct | null = null;

  const category = (name: string | null) => {
    current = { name, products: [] };
    categories.push(current);
    lastProduct = null;
  };

  const usable = lines.filter((l) => !isNoise(l.text));
  usable.forEach((line, index) => {
    const { name: rawName, prices } = splitPrices(line.text);
    const name = cleanName(rawName);
    if (prices.length > 0 && letters(name).length >= 2) {
      if (!current) category(null);
      const [price, ...more] = prices;
      lastProduct = {
        name,
        price: price!,
        description: more.length > 0 ? more.join(' / ') : '',
        confidence: Math.round(line.confidence),
        source: { page: line.page, box: line.box },
      };
      current!.products.push(lastProduct);
      return;
    }
    const text = cleanName(line.text);
    const next = usable[index + 1];
    const nextIsPriced = next !== undefined && splitPrices(next.text).prices.length > 0;
    const headingLike =
      text.length <= MAX_HEADING_LENGTH &&
      (isMostlyUppercase(text) || nextIsPriced || !lastProduct);
    if (headingLike && (isMostlyUppercase(text) || !lastProduct || /^\p{Lu}/u.test(text))) {
      category(text);
      return;
    }
    if (lastProduct) {
      const product: ParsedProduct = lastProduct;
      product.description = [product.description, text].filter(Boolean).join(' ');
      product.confidence = Math.min(product.confidence, Math.round(line.confidence));
    }
  });
  return categories.filter((c) => c.products.length > 0);
}
