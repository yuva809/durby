import { normalizePrice, type ParsedCategory, type ParsedProduct } from './parse';

/**
 * Menus from digital PDFs (docs/modules/catalog.md → Menu scan): when a page carries its text, the
 * text is read exactly from the PDF instead of being recognized from pixels — names, descriptions
 * and prices as printed. Pure: the pdf.js loading is in `ocr.ts`.
 *
 * The page's layout says what each piece is: the largest or sideways text is the category heading,
 * text in the size of the dish names starts an item (or continues its name on the next line),
 * smaller text below it is its description, prices are matched to the item on their row, volumes
 * (`0,4l`) become part of the name and tiny marks (allergen codes) are left out.
 */

/** One run of text on a PDF page, in page units with y growing downwards (baseline). */
export interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  /** Font size. */
  size: number;
  rotated: boolean;
}

/** Headings are at least this much larger than dish names. */
const HEADING_RATIO = 1.6;
/** Text at most this share of the dish-name size is a mark (allergen codes, footnotes). */
const MARK_RATIO = 0.5;
/** A price belongs to the item whose top is at most this many name sizes below it. */
const PRICE_REACH = 0.8;
/** Name lines this many sizes apart (or less) are one wrapped name. */
const WRAP_GAP = 1.4;
/** A volume header is over a price column when their left edges are this many name sizes apart. */
const COLUMN_REACH = 1.5;

const PRICE = /^(?:€\s?)?(\d{1,4}(?:[.,]\d{3})*[.,]\d{2})\s?(?:€|EUR)?$/i;
/** An item number on its own (`12.`, `12)`, `12a.`); bare `12` / `12a` only at the start of a row. */
const NUMBER = /^\d{1,3}[a-z]?[.)]$/i;
const BARE_NUMBER = /^\d{1,3}[a-z]?$/i;
/** An item number inside the name's own text run: `12. Soup`, `12a) Soup`, `12 Soup`. */
const NAME_NUMBER = /^(\d{1,3}[a-z]?)(?:[.)]\s*|\s+)(?=\p{L})/iu;
const numberText = (item: TextItem) => item.text.trim().replace(/[.)]$/, '');
const VOLUME = /^\d+(?:[.,]\d+)?\s?(?:l|cl|ml)$/i;

const priceOf = (text: string): string | null => {
  const match = PRICE.exec(text.trim());
  return match ? normalizePrice(match[1]!) : null;
};

/** A page with at least this many text runs carries its text; fewer means a scanned image. */
const TEXT_PAGE = 3;

/** Is the page's text in the PDF (read it), or is the page an image (recognize it)? */
export function hasText(items: readonly TextItem[]): boolean {
  return items.filter((i) => i.text.trim()).length >= TEXT_PAGE;
}

interface Entry {
  top: number;
  number: TextItem | null;
  names: TextItem[];
  descriptions: TextItem[];
  volumes: TextItem[];
  prices: TextItem[];
}

function mode(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}

const joinText = (items: readonly TextItem[]) =>
  [...items]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((i) => i.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.)])/g, '$1')
    .trim();

/**
 * One page's items → its products under the page's heading (or `previous`, the heading of an
 * earlier page, when this page has none). Returns the heading in force after this page.
 */
export function parseTextPage(
  items: readonly TextItem[],
  page: number,
  previous: string | null,
): { categories: ParsedCategory[]; heading: string | null } {
  const text = items.filter((i) => i.text.trim());
  const prices = text.filter((i) => !i.rotated && priceOf(i.text) !== null);
  // A bare number is an item number only when it starts a row with text after it; elsewhere it is
  // an allergen code or a note.
  const sameRow = (a: TextItem, b: TextItem) =>
    Math.abs(a.y - b.y) <= 0.6 * Math.max(a.size, b.size);
  const startsRow = (n: TextItem) =>
    text.some((i) => i !== n && sameRow(i, n) && i.x > n.x) &&
    !text.some((i) => i !== n && sameRow(i, n) && i.x < n.x);
  const numbers = text.filter((i) => {
    if (i.rotated) return false;
    const t = i.text.trim();
    return NUMBER.test(t) || (BARE_NUMBER.test(t) && startsRow(i));
  });
  const volumes = text.filter((i) => !i.rotated && VOLUME.test(i.text.trim()));
  const rest = text.filter(
    (i) => !i.rotated && !prices.includes(i) && !numbers.includes(i) && !volumes.includes(i),
  );
  // Dish names: the type on the item numbers' rows; without numbers, the larger of the two most
  // common sizes (descriptions have more lines than names, so they are often the most common).
  const onNumberRows = rest.filter((i) =>
    numbers.some((n) => Math.abs(n.y - i.y) <= 0.6 * n.size && i.x > n.x),
  );
  const counted = [...new Set(rest.map((i) => i.size))].map((size) => ({
    size,
    count: rest.filter((i) => i.size === size).length,
  }));
  // A size used once is a heading or a note, not the type of a list of dishes.
  const repeated = counted.filter((c) => c.count > 1);
  const common = (repeated.length > 0 ? repeated : counted)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((c) => c.size);
  const nameSize =
    onNumberRows.length > 0 ? mode(onNumberRows.map((i) => i.size)) : Math.max(0, ...common);
  const headings = text.filter((i) => i.rotated || i.size >= HEADING_RATIO * nameSize);
  const body = rest.filter((i) => !headings.includes(i) && i.size > MARK_RATIO * nameSize);
  const nameItems = body.filter((i) => i.size >= nameSize * 0.95);
  const descriptionItems = body.filter((i) => i.size < nameSize * 0.95);

  // The page heading: the largest heading text (a subtitle in smaller type is left out).
  const main = [...headings].sort((a, b) => b.size - a.size)[0];
  const heading = main ? main.text.trim() : previous;

  // Items: one per item number, or per name block when the page has no numbers.
  const entries: Entry[] = [];
  const newEntry = (top: number, number: TextItem | null): Entry => {
    const entry: Entry = { top, number, names: [], descriptions: [], volumes: [], prices: [] };
    entries.push(entry);
    return entry;
  };
  const sortedNames = [...nameItems].sort((a, b) => a.y - b.y || a.x - b.x);
  if (numbers.length > 0) {
    for (const n of [...numbers].sort((a, b) => a.y - b.y)) newEntry(n.y, n);
    for (const name of sortedNames) {
      const owner = [...entries].reverse().find((e) => e.top <= name.y + 0.6 * nameSize);
      (owner ?? entries[0]!).names.push(name);
    }
  } else {
    let last: TextItem | null = null;
    for (const name of sortedNames) {
      const between = descriptionItems.some((d) => last && d.y > last.y && d.y < name.y);
      const wraps = last !== null && name.y - last.y <= WRAP_GAP * nameSize && !between;
      if (wraps) entries[entries.length - 1]!.names.push(name);
      else newEntry(name.y, null).names.push(name);
      last = name;
    }
  }
  const usable = entries.filter((e) => e.names.length > 0);
  for (const e of usable) e.top = Math.min(e.top, ...e.names.map((n) => n.y));
  const ownerOf = (y: number, reach: number) =>
    [...usable].reverse().find((e) => e.top <= y + reach) ?? null;

  for (const d of descriptionItems) ownerOf(d.y, 0.3 * nameSize)?.descriptions.push(d);
  const columnHeaders: TextItem[] = [];
  for (const v of volumes) {
    const owner = ownerOf(v.y, 0.6 * nameSize);
    if (owner) owner.volumes.push(v);
    else columnHeaders.push(v);
  }
  for (const p of prices) ownerOf(p.y, PRICE_REACH * nameSize)?.prices.push(p);

  const products: ParsedProduct[] = [];
  for (const entry of usable) {
    // The dish number (ADR 0029): its own text run, or printed in front of the name.
    const joined = joinText(entry.names);
    const inName = entry.number ? null : NAME_NUMBER.exec(joined);
    const name = inName ? joined.slice(inName[0].length) : joined;
    const number = entry.number ? numberText(entry.number) : (inName?.[1] ?? null);
    const description = joinText(entry.descriptions);
    const source = {
      page,
      box: {
        x0: Math.min(...entry.names.map((n) => n.x)),
        y0: Math.min(...entry.names.map((n) => n.y - n.size)),
        x1: Math.max(...entry.names.map((n) => n.x + n.width)),
        y1: Math.max(...entry.names.map((n) => n.y + n.size * 0.25)),
      },
    };
    const priced = [...entry.prices].sort((a, b) => a.x - b.x);
    if (priced.length === 0) continue;
    // Volumes for the prices: a column header above each price, else the item's own volumes.
    const own = [...entry.volumes].sort((a, b) => a.x - b.x);
    const volumeFor = (price: TextItem, index: number): string | null => {
      const header = columnHeaders.find((h) => Math.abs(h.x - price.x) <= COLUMN_REACH * nameSize);
      if (header) return header.text.trim();
      if (own.length === priced.length) return own[index]!.text.trim();
      if (own.length === 1 && priced.length === 1) return own[0]!.text.trim();
      return null;
    };
    priced.forEach((price, index) => {
      const volume = volumeFor(price, index);
      const variant = volume ?? (priced.length > 1 ? String(index + 1) : null);
      products.push({
        name: variant ? `${name} ${variant}` : name,
        // Numbers are unique: of an item's sizes, the first carries it.
        ...(number && index === 0 && { number }),
        price: priceOf(price.text)!,
        description,
        confidence: 100,
        source,
      });
    });
  }
  return {
    categories: products.length > 0 ? [{ name: heading, products, suspect: false }] : [],
    heading,
  };
}

/** Every page in order; a page without a heading continues the one before. */
export function parseTextPages(
  pages: readonly { number: number; items: readonly TextItem[] }[],
): ParsedCategory[] {
  let heading: string | null = null;
  return pages.flatMap((p) => {
    const result = parseTextPage(p.items, p.number, heading);
    heading = result.heading;
    return result.categories;
  });
}
