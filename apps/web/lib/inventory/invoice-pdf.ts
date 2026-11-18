/**
 * Vendor invoices from their PDF (docs/modules/inventory.md → Vendor invoices, ADR 0049): the browser reads the PDF's
 * text, groups it into rows and picks out the item table ("Product ID · Description · Qty · Unit price · VAT ·
 * Total", as Bonesca and most wholesalers print it). No upload: only the receipt built from it goes to the api.
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
}

export interface ParsedInvoice {
  supplier: string | null;
  number: string | null;
  /** As printed, e.g. "10-11-2026". */
  date: string | null;
  lines: InvoiceLine[];
  /** The printed grand total, when found. */
  total: string | null;
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

/** Reads one table row, or null when the row isn't one. */
export function parseInvoiceRow(row: string): InvoiceLine | null {
  const match = ROW.exec(row.replace(/\s+/g, ' ').trim());
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
  // A labelled number with a digit in it ("Order number : 108666", "Rechnungsnummer 2026-14"), never "Order confirmation".
  const number =
    /(?:order|invoice|rechnungs?|bestell|factuur)\s*-?\s*(?:number|no\.?|nr\.?|nummer|#)\s*:?\s*([A-Z0-9/-]*\d[A-Z0-9/-]*)/i.exec(
      text,
    )?.[1] ?? null;
  const date = /\b(\d{1,2}[-./]\d{1,2}[-./]\d{4})\b/.exec(text)?.[1] ?? null;
  const domain = /[\w.+-]+@([a-z0-9-]+)\.[a-z.]{2,}/i.exec(text)?.[1] ?? null;
  const supplier =
    domain && !/^(gmail|outlook|hotmail|yahoo|gmx|web|icloud|t-online)$/i.test(domain)
      ? domain.charAt(0).toUpperCase() + domain.slice(1)
      : null;
  const lines = rows.map(parseInvoiceRow).filter((l): l is InvoiceLine => l !== null);
  // The grand total: the last "Total …" row that isn't "excluding VAT" / net.
  let total: string | null = null;
  for (const row of rows) {
    if (
      !/\btotal\b|\bsumme\b|\btotaal\b/i.test(row) ||
      /excl|netto|net\b|weight|weigt/i.test(row)
    ) {
      continue;
    }
    const amount = new RegExp(String.raw`(${NUMBER})\s*€?\s*$`).exec(row.trim())?.[1];
    const parsed = amount ? parseAmount(amount) : null;
    if (parsed) total = parsed;
  }
  return { supplier, number, date, lines, total };
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
