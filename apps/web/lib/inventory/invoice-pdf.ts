/**
 * Vendor invoices from their PDF (docs/modules/inventory.md → Vendor invoices, ADR 0049, 0058): the browser reads the
 * PDF's text, groups it into rows and picks out the item table. Three layouts: "Product ID · Description · Qty · Unit
 * price · VAT · Total" (Bonesca and most wholesalers), packed lines "Code · Description · Origin · Unit · Packs · Per
 * pack · Free · Pieces · Price · Total · VAT code" (Italian wholesalers), and "Pos · Art-Nr · Description · Qty · Per
 * pack · VAT % · Price · Total" (German wholesalers), and article first "Art-Nr · Qty · Unit (Karton) · Description · Price ·
 * Total" (Unidex and other Dutch wholesalers). No upload: only the receipt built from it goes to the api.
 */

export interface InvoiceLine {
  /** The supplier's product id, e.g. "1103-002"; null when the row has none. */
  code: string | null;
  description: string;
  /** Plain decimals ("50", "1245.5"), read from "50,00" or "1.245,50" alike. */
  quantity: string;
  unitPrice: string;
  vatRate: string | null;
  total: string;
  /** quantity × unit price is the printed total (to the cent): the row was read right. */
  checks: boolean;
  /**
   * A line invoiced in packs (ADR 0058): "4 CAR × 12 = 48 pcs". `quantity` and `unitPrice` are then as invoiced (the
   * packs); `pieces` and `piecePrice` the same goods counted by the piece. Absent for other lines.
   */
  pack?: { count: string; per: string; unit: string | null; pieces: string; piecePrice: string };
}

export interface ParsedInvoice {
  supplier: string | null;
  number: string | null;
  /** As printed, e.g. "10-11-2026". */
  date: string | null;
  lines: InvoiceLine[];
  /** The printed grand total, when found. */
  total: string | null;
  /** Rows read as lines but not goods (transport, "order confirmed"): left out, counted for the person (ADR 0058). */
  skipped: string[];
}

/** "1.245,00" → "1245.00", "50,00" → "50.00", "1,245.00" → "1245.00", "41.5" → "41.5"; null if not a number. */
export function parseAmount(raw: string): string | null {
  const text = raw.replace(/[€\s]/g, '');
  if (!/^\d[\d.,]*$/.test(text)) return null;
  const comma = text.lastIndexOf(',');
  const dot = text.lastIndexOf('.');
  let normal: string;
  if (comma >= 0 && dot >= 0) {
    // The later one is the decimal separator.
    normal = comma > dot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (comma >= 0) {
    normal = /^\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  } else {
    normal = text;
  }
  return /^\d+(\.\d+)?$/.test(normal) ? normal : null;
}

/** Thousandths, for exact checks without floating point (CLAUDE.md rule 6). */
function milli(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3));
}

const NUMBER = String.raw`\d[\d.,]*`;
/** A table row: [code] description qty [€] price [€] vat% [€] total — anchored at the end of the row. */
const ROW = new RegExp(
  String.raw`^(?:(?<code>(?=[A-Za-z./-]*\d)[A-Za-z0-9][A-Za-z0-9./-]{2,24})\s+)?(?<description>.+?)\s+(?<quantity>${NUMBER})\s*€?\s+€?\s*(?<price>${NUMBER})\s*€?\s+(?:(?<vat>\d{1,2}(?:[.,]\d+)?)\s*%\s*)?€?\s*(?<total>${NUMBER})\s*€?$`,
);
const HEADER_WORDS = /\b(description|beschreibung|omschrijving|qty|quantity|menge|aantal)\b/i;

/** A charge, not goods: transport, freight, an "order confirmed" line (ADR 0058). */
const NON_GOODS =
  /\b(trasporto|transport|transporte|freight|fracht|versand|versandkosten|shipping|spedizione|porto|order confirmed|surcharge|zuschlag|toeslag|label for missing language|pfand|deposit|statiegeld|leergut)\b/i;

/** European decimals as printed: "12,000", "1.245,00". */
const EU = String.raw`\d[\d.]*,\d+`;

/**
 * Packed lines (Italian wholesalers, ADR 0058): "10434 GOLDEN MORN 12x300GR NG CAR 4 12,000 0,000 48,000 2,51 120,48
 * 41%": code, description, origin, pack unit, packs, pieces per pack, free, pieces, price, total, VAT code. The price
 * is per piece or per pack, whichever times its quantity is the total.
 */
const PACKED = new RegExp(
  String.raw`^(?<code>\d{1,8})\s+(?<description>.+?)\s+(?:[A-Z]{2}\s+)?(?<unit>CAR|CNF|CRT|CT|BOX|PC|PZ|KRT|SAC|BAG|TRAY)\s+(?<packs>\d{1,6})\s+(?<per>${EU})\s+${EU}\s+(?<pieces>${EU})\s+(?<price>${EU})\s+(?<total>${EU})\s+\S+$`,
);

/**
 * Per position (German wholesalers, ADR 0058): "1. 1676 Annam Jack Mackerel Tin 24x425g 60 24 7% 33,36 2.001,60":
 * position, article number, description, quantity, pieces per pack ("Stk" for single pieces), VAT %, price, total.
 */
const PER_POSITION = new RegExp(
  String.raw`^(?:\d{1,3}\.?\s+)?(?<code>\d{2,8})\s+(?<description>.+?)\s+(?<quantity>\d{1,6}(?:,\d{1,3})?)\s+(?<per>\d{1,4}|stk\.?|st\.?|stück|stck)\s+(?<vat>\d{1,2}(?:[.,]\d+)?)\s*%\s+(?<price>${EU})\s+(?<total>${EU})$`,
  'i',
);

/** Packaging units printed after the quantity ("5 Karton", "100 Bag", "6 Bucket", "2 Shrink"). */
const PACKAGING = String.raw`(?:kartons?|cartons?|pieces?|pcs|stück|stk\.?|sack|säcke|kiste|beutel|dosen?|flaschen?|box(?:es)?|trays?|packs?|colli|bags?|buckets?|shrink|bundles?|bottles?|jars?|cans?|tins?|cases?|crates?|sachets?|rolls?|pails?|eimer|tüten?|zak(?:ken)?|doos|dozen|emmer)`;

/**
 * Article first (Unidex and other Dutch wholesalers): "FF00076 5 Karton Perfit Kingmackerel Steaks IQF (Surinam) 8 x 1 kg
 * 44,05 220,25": article number, quantity, packaging unit, description, then price and total. With a discount the
 * list price and discount come first: "… 12 x 1 ltr 41,75 10 % 37,58 75,15" (list price, %, net price, total); free
 * goods end at their list price and "100 %". With an article number any one-word packaging unit is taken; a row
 * without one is a charge such as "1 Karton Transport cost (EU) 125,00 125,00" and needs a known unit.
 */
const ARTICLE_HEAD = String.raw`^(?:(?<code>[A-Z]{1,6}\d{2,10}[A-Z]{0,3}|X[A-Z]{3,12})\s+(?<quantity>\d{1,3}(?:\.\d{3})*(?:,\d{1,3})?)\s+(?:${PACKAGING}|[A-Za-zÄÖÜäöüß]{2,12}\.?)|(?<chargeQuantity>\d{1,6}(?:,\d{1,3})?)\s+${PACKAGING})\s+(?<description>.+?)\s+`;
const ARTICLE_FIRST = new RegExp(
  ARTICLE_HEAD +
    String.raw`(?:(?<list>${EU})\s+(?<discount>\d{1,2}(?:[.,]\d+)?)\s*%\s+)?(?<price>${EU})\s+(?<total>${EU})$`,
  'i',
);
const ARTICLE_FREE = new RegExp(ARTICLE_HEAD + String.raw`(?<list>${EU})\s+100\s*%$`, 'i');

/** A description that goes on to the next row: it ends in "+", "&", "," or "/". */
const CONTINUED = /[+&,/]$/;

/** What a wrapped description leaves on the next row: the end of its pack size, "1 kg" or "gr". */
const WRAPPED_REST =
  /^(?:\d+(?:[.,]\d+)?\s*)?(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:kg|g|gr|ml|cl|l|ltr|pcs|stk|st)\.?$/i;

/** quantity × price is total within a cent. */
const checks = (quantity: string, price: string, total: string) => {
  const difference = (milli(quantity) * milli(price)) / 1000n - milli(total);
  return difference >= -10n && difference <= 10n;
};

/** total ÷ quantity, 4 decimals (rounded half up), exact. */
function per(total: string, quantity: string): string {
  const q = milli(quantity);
  if (q === 0n) return '0';
  // milli(total) / q gives units; scale by 10_000 for 4 decimals.
  const scaled = (milli(total) * 10_000n * 2n + q) / (2n * q);
  const whole = scaled / 10_000n;
  const fraction = String(scaled % 10_000n).padStart(4, '0');
  return `${whole}.${fraction}`;
}

/** A computed price as a person types it: "30.1200" → "30.12", "0.2635" stays. */
const trimPrice = (value: string) => value.replace(/(\.\d\d\d*?)0+$/, '$1');

/** A line invoiced in packs: as invoiced (packs, price per pack) and by the piece. */
function packedLine(input: {
  code: string;
  description: string;
  packs: string;
  perPack: string;
  unit: string | null;
  pieces: string;
  price: string;
  total: string;
  vatRate: string | null;
}): InvoiceLine {
  const { packs, pieces, price, total } = input;
  // Which count the printed price belongs to: the one whose product is the total.
  const perPiece = checks(pieces, price, total);
  const perPackPrice = perPiece ? trimPrice(per(total, packs)) : price;
  const piecePrice = perPiece ? price : trimPrice(per(total, pieces));
  return {
    code: input.code,
    description: input.description,
    quantity: packs,
    unitPrice: perPackPrice,
    vatRate: input.vatRate,
    total,
    checks: perPiece || checks(packs, price, total),
    pack: { count: packs, per: input.perPack, unit: input.unit, pieces, piecePrice },
  };
}

/** A European decimal as these layouts print it: "48,000" → "48.000", "1.245,00" → "1245.00"; null if not one. */
function eu(raw: string): string | null {
  const text = raw.trim().replace(/\./g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(text) ? text : null;
}

/** Plain decimals without trailing zeros: "12.000" → "12". */
const plain = (value: string) => (value.includes('.') ? value.replace(/\.?0+$/, '') : value);

/** The packed and per-position layouts (ADR 0058); null when the row is neither. */
function parseLayoutRow(row: string): InvoiceLine | null {
  const packed = PACKED.exec(row);
  if (packed?.groups) {
    const g = packed.groups;
    const packs = eu(g.packs ?? '');
    const perPack = eu(g.per ?? '');
    const pieces = eu(g.pieces ?? '');
    const price = eu(g.price ?? '');
    const total = eu(g.total ?? '');
    if (!packs || !perPack || !pieces || !price || !total || milli(packs) === 0n) return null;
    return packedLine({
      code: g.code!,
      description: (g.description ?? '').trim(),
      packs,
      perPack: plain(perPack),
      unit: g.unit ?? null,
      pieces: plain(pieces),
      price,
      total,
      vatRate: null,
    });
  }
  const position = PER_POSITION.exec(row);
  if (position?.groups) {
    const g = position.groups;
    const quantity = eu(g.quantity ?? '');
    const price = eu(g.price ?? '');
    const total = eu(g.total ?? '');
    if (!quantity || !price || !total || milli(quantity) === 0n) return null;
    const vatRate = eu(g.vat ?? '');
    const perPack = /^\d+$/.test(g.per ?? '') ? g.per! : null;
    if (perPack && perPack !== '1') {
      const pieces = String((milli(quantity) * BigInt(perPack)) / 1000n);
      return {
        code: g.code ?? null,
        description: (g.description ?? '').trim(),
        quantity,
        unitPrice: price,
        vatRate,
        total,
        checks: checks(quantity, price, total),
        pack: {
          count: quantity,
          per: perPack,
          unit: null,
          pieces,
          piecePrice: trimPrice(per(total, pieces)),
        },
      };
    }
    return {
      code: g.code ?? null,
      description: (g.description ?? '').trim(),
      quantity,
      unitPrice: price,
      vatRate,
      total,
      checks: checks(quantity, price, total),
    };
  }
  const article = ARTICLE_FIRST.exec(row);
  if (article?.groups) {
    const g = article.groups;
    const quantity = eu(g.quantity ?? g.chargeQuantity ?? '');
    const price = eu(g.price ?? '');
    const total = eu(g.total ?? '');
    if (!quantity || !price || !total || milli(quantity) === 0n) return null;
    // Discounted: the printed net price is rounded (8 × 6,89 ≠ 55,08), so the price is the total over the quantity.
    const unitPrice = g.discount ? trimPrice(per(total, quantity)) : price;
    return {
      code: g.code ?? null,
      description: (g.description ?? '').trim(),
      quantity,
      unitPrice,
      vatRate: null,
      total,
      checks: checks(quantity, unitPrice, total),
    };
  }
  // Free goods (100 % discount): booked in at no cost.
  const free = ARTICLE_FREE.exec(row);
  if (free?.groups) {
    const g = free.groups;
    const quantity = eu(g.quantity ?? g.chargeQuantity ?? '');
    if (!quantity || milli(quantity) === 0n) return null;
    return {
      code: g.code ?? null,
      description: (g.description ?? '').trim(),
      quantity,
      unitPrice: '0',
      vatRate: null,
      total: '0.00',
      checks: true,
    };
  }
  return null;
}

/** Reads one table row, or null when the row isn't one: the packed and per-position layouts first, then the plain one. */
export function parseInvoiceRow(row: string): InvoiceLine | null {
  const clean = row.replace(/\s+/g, ' ').trim();
  if (HEADER_WORDS.test(clean)) return null;
  const layout = parseLayoutRow(clean);
  if (layout) return layout.description.length >= 2 ? layout : null;
  const match = ROW.exec(clean);
  if (!match?.groups) return null;
  const g = match.groups;
  const description = (g.description ?? '').trim();
  if (description.length < 2 || HEADER_WORDS.test(row) || /\btotal\b/i.test(description)) {
    return null;
  }
  const quantity = parseAmount(g.quantity ?? '');
  const unitPrice = parseAmount(g.price ?? '');
  const total = parseAmount(g.total ?? '');
  if (!quantity || !unitPrice || !total || milli(quantity) === 0n) return null;
  // quantity × price, in tenths of a cent, against the printed total.
  const product = (milli(quantity) * milli(unitPrice)) / 1000n;
  const difference = product - milli(total);
  return {
    code: g.code ?? null,
    description,
    quantity,
    unitPrice,
    vatRate: g.vat ? (parseAmount(g.vat) ?? null) : null,
    total,
    checks: difference >= -10n && difference <= 10n,
  };
}

/**
 * The invoice from its text rows (top to bottom, each row's pieces left to right). Number and date come from labels
 * such as "Order number : 108666" or "Invoice no."; the supplier from the e-mail domain in the footer (editable).
 */
export function parseInvoice(rows: readonly string[]): ParsedInvoice {
  const text = rows.join('\n');
  // A labelled number with a digit in it ("Order number : 108666", "Rechnungsnummer 2026-14", "Rechnung II Nr.
  // RE22606995"), never "Order confirmation"; else the row after a lone "INVOICE" heading (ADR 0058).
  const number =
    /(?:order|invoice|rechnungs?|bestell|factuur|fattura|factura|facture)(?:\s+[A-Z]{1,3})?\s*-?\s*(?:number|no\.?|nr\.?|nummer|n°|#)\s*:?\s*([A-Z0-9/-]*\d[A-Z0-9/-]*)/i.exec(
      text,
    )?.[1] ?? headedNumber(rows);
  const date = /\b(\d{1,2}[-./]\d{1,2}[-./]\d{4})\b/.exec(text)?.[1] ?? null;
  // The e-mail domain, else the website's (Unidex prints only www.unidexholland.com).
  const domain =
    /[\w.+-]+@([a-z0-9-]+)\.[a-z.]{2,}/i.exec(text)?.[1] ??
    /\bwww\.([a-z0-9-]+)\.[a-z.]{2,}/i.exec(text)?.[1] ??
    null;
  const supplier =
    domain && !/^(gmail|outlook|hotmail|yahoo|gmx|web|icloud|t-online)$/i.test(domain)
      ? domain.charAt(0).toUpperCase() + domain.slice(1)
      : null;
  // Lines, and where the last one was: the totals are below it.
  const lines: InvoiceLine[] = [];
  const skipped: string[] = [];
  // Transport, surcharges: left out of the goods, but part of the printed total.
  const charges: InvoiceLine[] = [];
  let lastLine = -1;
  let previous: InvoiceLine | null = null;
  rows.forEach((row, index) => {
    const line = parseInvoiceRow(row);
    if (!line) {
      // A description wrapped onto the next row ("… 8 x" then "1 kg"): joined back.
      const rest = row.replace(/\s+/g, ' ').trim();
      const wrapped =
        WRAPPED_REST.test(rest) ||
        // "… 4750 gr +" then "wobbler & display"; never a campaign note or a page's footer.
        (previous !== null &&
          CONTINUED.test(previous.description) &&
          rest.length <= 60 &&
          !/:/.test(rest));
      if (previous && index === lastLine + 1 && wrapped) {
        previous.description = `${previous.description} ${rest}`;
        lastLine = index;
      }
      return;
    }
    lastLine = index;
    previous = line;
    if (NON_GOODS.test(line.description)) {
      skipped.push(line.description);
      charges.push(line);
    } else lines.push(line);
  });
  // The grand total: the last "Total …" row that isn't "excluding VAT" / net.
  let total: string | null = null;
  for (const row of rows) {
    if (
      !/\btotal\b|\bsumme\b|\btotaal\b|\bgesamtbetrag\b/i.test(row) ||
      /excl|netto|net\b|ohne|weight|weigt/i.test(row)
    ) {
      continue;
    }
    const amount = new RegExp(String.raw`(${NUMBER})\s*€?\s*$`).exec(row.trim())?.[1];
    const parsed = amount ? parseAmount(amount) : null;
    if (parsed) total = parsed;
  }
  const merged = mergeRepeated(lines);
  lines.splice(0, lines.length, ...merged);
  // No labelled total that is the lines' sum (a gross total, or none at all): an amount below the lines that is the
  // net sum, as wholesalers print it without a label (ADR 0058).
  const sum = lines.length > 0 ? linesTotal(lines) : null;
  // A printed total that is the goods plus the charges left out: the goods' total is what the lines are checked
  // against (the charges are named as left out).
  if (sum && total && charges.length > 0 && total === linesTotal([...lines, ...charges])) {
    total = sum;
  }
  if (sum && total !== sum && lastLine >= 0) {
    const below = rows.slice(lastLine + 1).join(' ');
    const amounts = [...below.matchAll(/\d[\d.,]*\d/g)].map((m) => parseAmount(m[0]));
    if (amounts.some((a) => a !== null && milli(a) === milli(sum))) total = sum;
  }
  return { supplier, number, date, lines, total, skipped };
}

/**
 * Lines of one product (same code and description) as one (ADR 0058): wholesalers print free goods as a second line at
 * 0.00. Quantities and totals are added; the price is the total over the quantity (4 decimals).
 */
export function mergeRepeated(lines: readonly InvoiceLine[]): InvoiceLine[] {
  const merged: InvoiceLine[] = [];
  const index = new Map<string, number>();
  for (const line of lines) {
    const key = line.code ? `${line.code}|${line.description.toLowerCase()}` : null;
    const at = key ? index.get(key) : undefined;
    if (key === null || at === undefined) {
      if (key) index.set(key, merged.length);
      merged.push(line);
      continue;
    }
    const first = merged[at]!;
    const quantity = add(first.quantity, line.quantity);
    const total = linesTotal([first, line]);
    const pack =
      first.pack && line.pack
        ? {
            ...first.pack,
            count: add(first.pack.count, line.pack.count),
            pieces: add(first.pack.pieces, line.pack.pieces),
          }
        : undefined;
    merged[at] = {
      ...first,
      quantity,
      unitPrice: trimPrice(per(total, quantity)),
      total,
      checks: first.checks && line.checks,
      ...(pack ? { pack: { ...pack, piecePrice: trimPrice(per(total, pack.pieces)) } } : {}),
    };
  }
  return merged;
}

/** a + b, exact to thousandths, as a plain decimal. */
function add(a: string, b: string): string {
  const sum = milli(a) + milli(b);
  const fraction = String(sum % 1000n)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return fraction ? `${sum / 1000n}.${fraction}` : String(sum / 1000n);
}

/** The invoice number on the row after a lone "INVOICE" (or Rechnung, Fattura …) heading; null when there is none. */
function headedNumber(rows: readonly string[]): string | null {
  for (let i = 0; i < rows.length - 1; i++) {
    if (!/^(invoice|rechnung|fattura|factura|facture|factuur)$/i.test(rows[i]!.trim())) continue;
    const next = rows[i + 1]!.trim();
    if (/^[A-Z0-9/-]*\d[A-Z0-9/-]*$/i.test(next)) return next;
  }
  return null;
}

/** The sum of line totals, 2 decimals, exact. */
export function linesTotal(lines: readonly Pick<InvoiceLine, 'total'>[]): string {
  const sum = lines.reduce((acc, l) => acc + milli(l.total), 0n);
  return `${sum / 1000n}.${String((sum % 1000n) / 10n).padStart(2, '0')}`;
}

// --- Reading the PDF (browser only) --------------------------------------------------------------------------

/** The worker of the bundled pdfjs version (same as the menu scan). */
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs';
const MAX_PAGES = 20;

export class InvoicePdfError extends Error {
  constructor(readonly reason: 'unreadable' | 'noText' | 'tooManyPages') {
    super(reason);
  }
}

/**
 * The PDF's text as rows, top to bottom per page: pieces whose baselines are within a few points form one row, read
 * left to right. A PDF without text (a scan) has none: InvoicePdfError('noText').
 */
export async function pdfRows(file: Blob): Promise<string[]> {
  let doc;
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch {
    throw new InvoicePdfError('unreadable');
  }
  if (doc.numPages > MAX_PAGES) throw new InvoicePdfError('tooManyPages');
  const rows: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const pieces: { text: string; x: number; y: number }[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const transform = item.transform as number[];
      pieces.push({ text: item.str.trim(), x: transform[4] ?? 0, y: transform[5] ?? 0 });
    }
    pieces.sort((a, b) => b.y - a.y || a.x - b.x);
    let current: typeof pieces = [];
    const flush = () => {
      if (current.length === 0) return;
      rows.push(
        current
          .sort((a, b) => a.x - b.x)
          .map((p) => p.text)
          .join(' '),
      );
      current = [];
    };
    for (const piece of pieces) {
      if (current.length > 0 && Math.abs(current[0]!.y - piece.y) > 3) flush();
      current.push(piece);
    }
    flush();
    page.cleanup();
  }
  if (rows.length === 0) throw new InvoicePdfError('noText');
  return rows;
}

// --- Photos and scans (ADR 0054) -----------------------------------------------------------------------------

/** A line of text as the on-device recognition reads it: its page and box (any unit, y down). */
export interface ReadLine {
  text: string;
  page: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Lines read from a photo or scan as table rows: per page, pieces whose vertical centres lie within half a line
 * height of each other form one row, read left to right (recognition reads columns apart).
 */
export function linesToRows(lines: readonly ReadLine[]): string[] {
  const rows: string[] = [];
  const pages = [...new Set(lines.map((l) => l.page))].sort((a, b) => a - b);
  for (const page of pages) {
    const own = lines
      .filter((l) => l.page === page && l.text.trim() !== '')
      .map((l) => ({
        ...l,
        mid: (l.box.y0 + l.box.y1) / 2,
        height: Math.max(1, l.box.y1 - l.box.y0),
      }))
      .sort((a, b) => a.mid - b.mid);
    let current: typeof own = [];
    const flush = () => {
      if (current.length === 0) return;
      rows.push(
        current
          .sort((a, b) => a.box.x0 - b.box.x0)
          .map((l) => l.text.trim())
          .join(' '),
      );
      current = [];
    };
    for (const line of own) {
      const anchor = current[0];
      if (anchor && Math.abs(line.mid - anchor.mid) > Math.min(anchor.height, line.height) / 2) {
        flush();
      }
      current.push(line);
    }
    flush();
  }
  return rows;
}

/**
 * Photos (JPG, PNG …) or a scanned PDF read on the device with the menu scan's recognition (no upload), as rows.
 * Less exact than a PDF's own text: every line is checked in the review.
 */
export async function scanRows(
  files: readonly File[],
  onProgress?: (share: number) => void,
): Promise<string[]> {
  const { preparePages, recognizePages, ScanError } = await import('../catalog/menu-scan/ocr');
  let pages;
  try {
    pages = await preparePages(files);
  } catch (error) {
    if (error instanceof ScanError && error.kind === 'tooManyPages') {
      throw new InvoicePdfError('tooManyPages');
    }
    throw new InvoicePdfError('unreadable');
  }
  // Pages that carry text (a PDF mixed with scans) are read as such; the rest by recognition.
  const textRows = pages.flatMap((page) =>
    page.text
      ? linesToRows(
          page.text.map((t) => ({
            text: t.text,
            page: page.number,
            box: { x0: t.x, x1: t.x + t.width, y0: t.y - t.size, y1: t.y },
          })),
        )
      : [],
  );
  const read = await recognizePages(pages, (p) =>
    onProgress?.((p.page - 1 + p.progress) / Math.max(1, p.pages)),
  );
  const rows = [...textRows, ...linesToRows(read)];
  if (rows.length === 0) throw new InvoicePdfError('noText');
  return rows;
}
