import type { Translator } from '@durby/i18n';
import type { ProductCategory } from '@durby/shared';
import { shortQuantity } from './format';
import { categoryPath, type ItemRow, sumDecimals } from './overview';

/**
 * The inventory page's Export (docs/modules/inventory.md → Categories and the operations inventory page): what is
 * listed, as Excel, CSV or PDF, made in the browser. One table feeds all three; the writers are loaded on first use.
 */

export interface ExportCell {
  /** As shown and in CSV. */
  text: string;
  /** A decimal string, written as a number to Excel. */
  number?: string;
  decimals?: 2 | 3;
  /** An amount in the organization's currency (PDF formats it). */
  money?: boolean;
}

export interface ExportTable {
  header: string[];
  rows: ExportCell[][];
  /** The sum of the value column; null without prices. */
  total: string | null;
}

export function inventoryTable(
  listed: readonly ItemRow[],
  {
    t,
    prices,
    categories,
  }: { t: Translator; prices: boolean; categories: readonly ProductCategory[] },
): ExportTable {
  const text = (value: string): ExportCell => ({ text: value });
  return {
    header: [
      t('inventory.fields.item'),
      t('inventory.fields.sku'),
      t('inventory.fields.category'),
      t('inventory.fields.unit'),
      t('inventory.fields.quantity'),
      ...(prices ? [t('inventory.fields.value')] : []),
      t('inventory.overview.lowStock'),
    ],
    rows: listed.map((r) => [
      text(r.item.name),
      text(r.item.sku ?? ''),
      text(categoryPath(categories, r.item.categoryId)),
      text(t(`inventory.units.${r.item.unit}`)),
      { text: shortQuantity(r.quantity), number: r.quantity, decimals: 3 },
      ...(prices
        ? [
            r.value === null
              ? text('')
              : { text: r.value, number: r.value, decimals: 2 as const, money: true },
          ]
        : []),
      text(r.low ? t('inventory.overview.yes') : ''),
    ]),
    total: prices
      ? sumDecimals(
          listed.map((r) => r.value ?? '0'),
          2,
        )
      : null,
  };
}

export const csvRows = (table: ExportTable): string[][] =>
  table.rows.map((row) => row.map((cell) => cell.text));

const valueColumn = (table: ExportTable) => table.rows[0]?.findIndex((c) => c.money) ?? -1;

/** A workbook with one sheet: bold, frozen header; numbers as numbers; the value total. */
export async function xlsxBlob(
  table: ExportTable,
  { sheet, totalLabel }: { sheet: string; totalLabel: string },
): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const head = table.header.map((value) => ({ value, fontWeight: 'bold' as const }));
  const body = table.rows.map((row) =>
    row.map((cell) =>
      cell.number === undefined
        ? { value: cell.text, type: String }
        : {
            value: Number(cell.number),
            type: Number,
            format: cell.decimals === 2 ? '#,##0.00' : '#,##0.###',
          },
    ),
  );
  const at = valueColumn(table);
  const foot =
    table.total !== null && at >= 0
      ? [
          table.header.map((_, i) =>
            i === 0
              ? { value: totalLabel, fontWeight: 'bold' as const }
              : i === at
                ? {
                    value: Number(table.total),
                    type: Number,
                    format: '#,##0.00',
                    fontWeight: 'bold' as const,
                  }
                : null,
          ),
        ]
      : [];
  const widths = table.header.map((h, i) =>
    Math.min(48, Math.max(h.length, ...table.rows.map((r) => r[i]?.text.length ?? 0)) + 2),
  );
  return writeXlsxFile([head, ...body, ...foot], {
    sheet,
    columns: widths.map((width) => ({ width })),
    stickyRowsCount: 1,
  }).toBlob();
}

export interface PdfHeading {
  title: string;
  /** Organization, printed time, filters: one per line under the title. */
  lines: string[];
  totalLabel: string;
  page: (page: number, pages: number) => string;
  money: (amount: string) => string;
}

/** A4 landscape: title and lines, the table (header on every page), the total, "Page x of y". */
export async function pdfBlob(table: ExportTable, heading: PdfHeading): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const margin = 36;
  doc.setFontSize(16);
  doc.text(heading.title, margin, margin + 6);
  doc.setFontSize(9);
  heading.lines.forEach((line, i) => doc.text(line, margin, margin + 24 + i * 12));
  const at = valueColumn(table);
  const right = Object.fromEntries(
    table.header.flatMap((_, i) =>
      table.rows.some((r) => r[i]?.number !== undefined) ? [[i, { halign: 'right' as const }]] : [],
    ),
  );
  autoTable(doc, {
    startY: margin + 24 + heading.lines.length * 12,
    margin: { left: margin, right: margin, bottom: margin + 12 },
    head: [table.header.map((content, i) => ({ content, styles: right[i] ?? {} }))],
    body: table.rows.map((row) => row.map((c) => (c.money ? heading.money(c.text) : c.text))),
    ...(table.total !== null && at >= 0
      ? {
          foot: [
            table.header.map((_, i) =>
              i === at
                ? { content: heading.money(table.total!), styles: { halign: 'right' as const } }
                : i === 0
                  ? heading.totalLabel
                  : '',
            ),
          ],
          showFoot: 'lastPage' as const,
        }
      : {}),
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [60, 60, 60] },
    footStyles: { fillColor: [235, 235, 235], textColor: 20 },
    columnStyles: right,
  });
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(8);
    const { width, height } = doc.internal.pageSize;
    doc.text(heading.page(page, pages), width - margin, height - margin / 2, { align: 'right' });
  }
  return doc.output('blob');
}
