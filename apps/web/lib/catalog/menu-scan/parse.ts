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
  /** The vertical strip of the page it was read from (`findStrips`), left to right. */
  strip?: number;
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
  /** The heading is doubtful: cut off (starts lowercase), very short or read with low confidence. */
  suspect: boolean;
}

/** One word as the OCR engine read it, with its own box. */
export interface OcrWord {
  text: string;
  confidence: number;
  box: Box;
}

/** A gap wider than this many word heights separates two columns on one OCR line. */
const COLUMN_GAP = 1.5;
/** Segments whose left edges are this close (share of the page width) are one column. */
const COLUMN_TOLERANCE = 0.08;
/** A column has at least this many segments; fewer join the column they sit in. */
const MIN_COLUMN_SEGMENTS = 3;
/** Text this much taller than its neighbour is set in a larger size (a heading). */
const HEADING_RATIO = 1.4;
/** Words whose centres are this many heights apart vertically sit on different rows. */
const ROW_SHIFT = 0.4;
/** A strip in which at least this share of lines are prices alone is a price column. */
const PRICE_STRIP = 0.6;

const height = (item: { box: Box }) => item.box.y1 - item.box.y0;
const centre = (item: { box: Box }) => (item.box.y0 + item.box.y1) / 2;

/**
 * One OCR line → one line per menu column. OCR engines often read across columns
 * (`Soup 650.00 ⟶ Prawns 1,950.00`); a wide gap splits the line, except in front of a price, so a
 * name and its far-right price stay together.
 */
export function segmentLine(words: readonly OcrWord[], page: number, strip?: number): OcrLine[] {
  const segments: OcrWord[][] = [];
  let current: OcrWord[] = [];
  words.forEach((word, index) => {
    const previous = words[index - 1];
    if (previous && current.length > 0) {
      const gapHeight = Math.max(height(word), height(previous), 1);
      const gap = word.box.x0 - previous.box.x1;
      const priceNext = normalizePrice(word.text) !== null || CURRENCY_ONLY.test(word.text);
      // A heading beside a price ("Breads   EUR 3,90" read as one line) is set larger or sits
      // higher: two things, and the price belongs to the item on its row (`joinRows`).
      const otherRow =
        height(previous) > HEADING_RATIO * height(word) ||
        Math.abs(centre(previous) - centre(word)) > ROW_SHIFT * gapHeight;
      if (gap > COLUMN_GAP * gapHeight && (!priceNext || otherRow)) {
        segments.push(current);
        current = [];
      }
    }
    current.push(word);
  });
  if (current.length > 0) segments.push(current);
  return segments.map((ws) => ({
    text: ws.map((w) => w.text).join(' '),
    confidence: Math.min(...ws.map((w) => w.confidence)),
    page,
    ...(strip !== undefined && { strip }),
    box: {
      x0: Math.min(...ws.map((w) => w.box.x0)),
      y0: Math.min(...ws.map((w) => w.box.y0)),
      x1: Math.max(...ws.map((w) => w.box.x1)),
      y1: Math.max(...ws.map((w) => w.box.y1)),
    },
  }));
}

/**
 * One page's segments in reading order: column by column (left to right), top to bottom in each.
 * Columns are found by left edges; a centred heading or a lone note joins the column whose width
 * it lies in (else the one to its left).
 */
export function orderColumns(lines: readonly OcrLine[], pageWidth: number): OcrLine[] {
  // Strips are columns already (left to right); columns are still looked for inside each one.
  const strips = [...new Set(lines.map((l) => l.strip ?? 0))].sort((a, b) => a - b);
  if (strips.length > 1) {
    return strips.flatMap((strip) =>
      orderColumns(
        lines.filter((l) => (l.strip ?? 0) === strip).map((l) => ({ ...l, strip: 0 })),
        pageWidth,
      ),
    );
  }
  const tolerance = COLUMN_TOLERANCE * pageWidth;
  const clusters: { x0: number; lines: OcrLine[] }[] = [];
  for (const line of [...lines].sort((a, b) => a.box.x0 - b.box.x0)) {
    const last = clusters[clusters.length - 1];
    if (last && line.box.x0 - last.x0 <= tolerance) last.lines.push(line);
    else clusters.push({ x0: line.box.x0, lines: [line] });
  }
  const range = (c: (typeof clusters)[number]) => ({
    x0: c.x0,
    x1: Math.max(...c.lines.map((l) => l.box.x1)),
  });
  // Centred headings ("Breads", "Desserts") line up with each other but sit inside a column.
  const inside = (c: (typeof clusters)[number]) =>
    clusters.some((other) => {
      if (other === c || other.lines.length <= c.lines.length) return false;
      const r = range(other);
      return c.lines.every((l) => (l.box.x0 + l.box.x1) / 2 <= r.x1 && l.box.x0 >= r.x0);
    });
  const major = clusters.filter((c) => c.lines.length >= MIN_COLUMN_SEGMENTS && !inside(c));
  if (major.length === 0) return [...lines].sort((a, b) => a.box.y0 - b.box.y0);
  const columns = major.map((c) => ({
    x0: c.x0,
    x1: Math.max(...c.lines.map((l) => l.box.x1)),
    lines: [...c.lines],
  }));
  for (const cluster of clusters) {
    if (major.includes(cluster)) continue;
    for (const line of cluster.lines) {
      const mid = (line.box.x0 + line.box.x1) / 2;
      const home =
        columns.filter((c) => mid >= c.x0 && mid <= c.x1).at(-1) ??
        [...columns].reverse().find((c) => c.x0 <= line.box.x0) ??
        columns[0]!;
      home.lines.push(line);
    }
  }
  return columns.flatMap((column) => column.lines.sort((a, b) => a.box.y0 - b.box.y0));
}

/**
 * Puts pieces of one menu row back together: a price on its own (read apart from its name, e.g.
 * across a wide gap) joins the unpriced line to its left on the same row; so does a priced
 * continuation that starts with `(` or a lowercase letter (`Curry  (mild)  EUR 18,90`).
 */
export function joinRows(lines: readonly OcrLine[]): OcrLine[] {
  const out = lines.map((l) => ({ ...l, box: { ...l.box } }));
  // A strip of prices alone (split from its names at a wide gap) joins the strip to its left.
  const priceStrips = new Set<number>();
  for (const strip of new Set(out.map((l) => l.strip ?? 0))) {
    const inStrip = out.filter((l) => (l.strip ?? 0) === strip);
    const alone = inStrip.filter((l) => {
      const split = splitPrices(l.text);
      return split.prices.length > 0 && letters(split.name).length < 2;
    });
    if (alone.length >= PRICE_STRIP * inStrip.length) priceStrips.add(strip);
  }
  const removed = new Set<number>();
  out.forEach((piece, index) => {
    const { name, prices } = splitPrices(piece.text);
    if (prices.length === 0) return;
    const priceOnly = letters(name).length < 2;
    const continuation = /^[([{\p{Ll}]/u.test(name.trim());
    if (!priceOnly && !continuation) return;
    let best = -1;
    let bestDistance = Infinity;
    out.forEach((other, i) => {
      if (i === index || removed.has(i) || other.page !== piece.page) return;
      const strip = piece.strip ?? 0;
      const otherStrip = other.strip ?? 0;
      if (otherStrip !== strip && !(priceStrips.has(strip) && otherStrip === strip - 1)) return;
      if (other.box.x1 > piece.box.x0 + 2) return;
      if (splitPrices(other.text).prices.length > 0) return;
      const distance = Math.abs(centre(other) - centre(piece));
      if (distance > 0.6 * Math.max(height(piece), height(other))) return;
      const closer = distance < bestDistance - 1;
      const sameButNearer =
        Math.abs(distance - bestDistance) <= 1 && best >= 0 && other.box.x1 > out[best]!.box.x1;
      if (closer || sameButNearer) {
        best = i;
        bestDistance = distance;
      }
    });
    if (best < 0) return;
    const target = out[best]!;
    target.text = `${target.text} ${piece.text}`;
    target.confidence = Math.min(target.confidence, piece.confidence);
    target.box = {
      x0: Math.min(target.box.x0, piece.box.x0),
      y0: Math.min(target.box.y0, piece.box.y0),
      x1: Math.max(target.box.x1, piece.box.x1),
      y1: Math.max(target.box.y1, piece.box.y1),
    };
    removed.add(index);
  });
  return out.filter((_, i) => !removed.has(i));
}

/** A menu's price can't be millions: longer digit runs are phone numbers, dates or codes. */
const MAX_PRICE_DIGITS = 7;
const MAX_HEADING_LENGTH = 60;
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
  // OCR sticks stray marks to prices (`16,9(`, `18,90!`) and adds specks after them (`14,90 4`).
  const tokens = text.trim().split(/\s+/);
  // Only the tokens read as prices (from the end) are cleaned; `(2 Stück)` in a name stays.
  const asPrice = (t: string): string => {
    const bare = t
      .replace(/^[([{]+(?=\d)/, '')
      .replace(/[()[\]{}!;:|'"„“”]+$/, '')
      .replace(/(?<=\d)[.,]$/, '');
    if (/\d/.test(t) && normalizePrice(bare) !== null) return bare;
    // Digit look-alikes in a price with a decimal mark (`16,9¢`, `1O,5O`, `l2,50`).
    if (/^[\dOoQD¢©lI|!SB]+[.,][\dOoQD¢©lI|!SB]{1,2}$/.test(bare) && /\d.*\d/.test(bare)) {
      const digits = bare
        .replace(/[OoQD¢©]/g, '0')
        .replace(/[lI|!]/g, '1')
        .replace(/S/g, '5')
        .replace(/B/g, '8');
      if (normalizePrice(digits) !== null) return digits;
    }
    return t;
  };
  // Rules and specks after the price (`EUR 14,90 |`).
  while (tokens.length > 0 && !/[\p{L}\d€$£₹]/u.test(tokens[tokens.length - 1]!)) tokens.pop();
  const prices: string[] = [];
  const raw: string[] = [];
  // Rejoin "1 500,00" style groups and "Rs. 450" before reading from the end.
  while (tokens.length > 0) {
    const last = asPrice(tokens[tokens.length - 1]!);
    if (CURRENCY_ONLY.test(last)) {
      tokens.pop();
      continue;
    }
    const price = normalizePrice(last);
    if (price === null) break;
    tokens.pop();
    if (tokens.length > 0 && CURRENCY_ONLY.test(tokens[tokens.length - 1]!)) tokens.pop();
    prices.unshift(price);
    raw.unshift(last);
  }
  // Once a price has decimals, a later whole number on the line is a speck, not a second price.
  const first = raw.findIndex((r) => /[.,]\d{1,2}$/.test(r));
  if (first >= 0) {
    for (let i = raw.length - 1; i > first; i--) {
      if (!/[.,]\d{1,2}$/.test(raw[i]!)) prices.splice(i, 1);
    }
  }
  return { name: tokens.join(' '), prices };
}

/** Item numbers, dot leaders and trailing separators off a product name. */
export function cleanName(text: string): string {
  return (
    text
      // Item numbers: `12 Soup`, `12. Soup`, `67.Naan`, `67Naan`, `7 2.Poori`, `¢7 Naan`, `(8 Naan`;
      // a lone digit glued to a word stays (`1dly` is a misread `Idly`).
      .replace(/^\s*[#(¢$§]?\s?(?:\d{2,3}|\d(?=[\s.,):-]))(?:\s?[\d¢$§])?[.,):-]?\s*(?=\p{L})/u, '')
      .replace(/^\s*[•*·-]\s+/, '')
      .replace(/[.·…_]{2,}/g, ' ')
      .replace(/[\s:;,|–—-]+$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

const letters = (text: string) => text.replace(/[^\p{L}]/gu, '');

function isMostlyUppercase(text: string): boolean {
  const l = letters(text);
  if (l.length < 3) return false;
  const upper = l.replace(/[^\p{Lu}]/gu, '').length;
  return upper / l.length >= 0.7;
}

/** Unpriced text smaller than this share of the menu's product lines is a description. */
const DESCRIPTION_RATIO = 0.7;
/** Unpriced lines read with less confidence than this, and mostly not letters, are specks. */
const NOISE_CONFIDENCE = 30;
/** A heading read with less confidence than this is doubtful. */
const SUSPECT_CONFIDENCE = 50;
/** A menu where at least this share of prices has cents is priced with cents. */
const CENTS_MENU = 0.8;

function isNoise(line: OcrLine): boolean {
  const count = letters(line.text).length;
  if (count < 2) return true;
  if (splitPrices(line.text).prices.length > 0) return false;
  // Specks from photos and ornaments: little confidence, and mostly not letters or no real word.
  if (line.confidence >= NOISE_CONFIDENCE) return false;
  const longestWord = Math.max(...line.text.split(/\s+/).map((w) => letters(w).length));
  return count < 0.6 * line.text.replace(/\s/g, '').length || longestWord < 4;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The menu's categories and products. A line ending in a price is a product. An unpriced line is
 * the description of the product above when it is set smaller than product lines, reads like a
 * sentence, or starts lowercase without a priced line after it; otherwise, when short and either
 * mostly uppercase or followed by a priced line, a category heading.
 */
export function parseMenu(lines: readonly OcrLine[]): ParsedCategory[] {
  const categories: ParsedCategory[] = [];
  let current: ParsedCategory | null = null;
  let lastProduct: ParsedProduct | null = null;

  const category = (name: string | null, suspect = false) => {
    current = { name, products: [], suspect };
    categories.push(current);
    lastProduct = null;
  };

  const usable = lines.filter((l) => !isNoise(l));
  const productHeight = median(
    usable.filter((l) => splitPrices(l.text).prices.length > 0).map(height),
  );
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
    const isSmall = (l: OcrLine) =>
      productHeight > 0 && height(l) < DESCRIPTION_RATIO * productHeight;
    // A priced line follows, maybe after a subtitle in small print ("Hauptgericht" / "mit Reis").
    const after = usable.slice(index + 1, index + 3);
    const nextPriced = after.findIndex((l) => splitPrices(l.text).prices.length > 0);
    const nextIsPriced = nextPriced === 0 || (nextPriced === 1 && isSmall(after[0]!));
    const small = isSmall(line);
    // Prose, not a heading: ends like a sentence, is long, or lists with several lowercase words.
    const lowercaseWords = text.split(/\s+/).filter((w) => /^\p{Ll}/u.test(w)).length;
    const sentence =
      /[.,;]$/.test(text) ||
      text.length > MAX_HEADING_LENGTH ||
      (text.includes(',') && lowercaseWords > 2);
    const lowercase = /^\p{Ll}/u.test(text);
    const heading =
      !small &&
      !sentence &&
      letters(text).length >= 3 &&
      (isMostlyUppercase(text) || nextIsPriced || !lastProduct) &&
      (!lowercase || nextIsPriced);
    if (heading) {
      const doubtful =
        lowercase || letters(text).length < 4 || line.confidence < SUSPECT_CONFIDENCE;
      category(text, doubtful);
      return;
    }
    if (lastProduct) {
      const product: ParsedProduct = lastProduct;
      product.description = [product.description, text].filter(Boolean).join(' ');
    }
  });
  // Specks read as products: no real word, or a whole-number price on a menu priced with cents.
  const all = categories.flatMap((c) => c.products);
  const cents = all.filter((p) => !p.price.endsWith('.00')).length >= CENTS_MENU * all.length;
  for (const c of categories) {
    c.products = c.products.filter((p) => {
      if (p.confidence >= SUSPECT_CONFIDENCE) return true;
      const longestWord = Math.max(...p.name.split(/\s+/).map((w) => letters(w).length));
      return longestWord >= 3 && !(cents && p.price.endsWith('.00'));
    });
  }
  return categories.filter((c) => c.products.length > 0);
}
