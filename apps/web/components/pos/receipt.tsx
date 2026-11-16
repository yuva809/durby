'use client';

import {
  type BillLayout,
  type BillText,
  type BillTextPart,
  DEFAULT_BILL_FOOTER,
  DEFAULT_BILL_HEADER,
  DEFAULT_BILL_TEXT,
  printTextScale,
} from '@durby/shared';
import { useT } from '../../app/labels-provider';
import type { BillLine } from '../../lib/pos/format';
import { useMoney } from './money';

/** What the fixed middle of the bill shows: the order as printed (ADR 0025). */
export interface ReceiptOrder {
  number: string;
  covers: number | null;
  waiterName: string | null;
  total: string;
}

/**
 * The guest bill on the 80 mm roll (docs/modules/pos.md → Printing, ADR 0025), in three parts:
 * the organization's **header** (logo, name, phone, email, website from `pos.billHeader`, empty
 * fields left out), the **middle** that is the same for everyone (waiter, table and guests, bill
 * number, items as "quantity × name" with their total, the TOTAL), and the **footer** (the lines of
 * `pos.billFooter` or a thank-you, the interim-bill notice, "Powered by" the product, date and
 * time). No VAT breakdown and no TSE data (decision 2026-11-02).
 *
 * Text sizes come from `pos.billText` (docs/modules/pos.md → Text size): the overall size scales everything, a part
 * with its own size (header, items, total, footer) uses that instead. Type inside is in `em`, so it follows.
 *
 * The notice "Interim bill – not a fiscal receipt" / "Zwischenrechnung – kein Kassenbeleg" is printed on every bill
 * and no setting removes it: without a TSE, a bill printed here must never pass for a receipt (ADR 0016). The fiscal
 * module replaces it with the TSE data.
 */
export function Receipt({
  layout,
  organizationName,
  productName,
  tableName,
  order,
  bill,
  printedAt,
  banner = null,
  cancelled = false,
}: {
  /** Null while it loads or when it can't be read: the defaults (organization name, thanks). */
  layout: (Pick<BillLayout, 'header' | 'footer'> & { text?: BillText }) | null;
  organizationName: string;
  productName: string;
  tableName: string;
  order: ReceiptOrder;
  bill: BillLine[];
  printedAt: Date;
  /** Under the number, e.g. "Share 2 of 4" on a share of an equal split (ADR 0036). */
  banner?: string | null;
  /** A check of a cancelled bill: "CANCELLED" in large letters above the items. */
  cancelled?: boolean;
}) {
  const t = useT();
  const money = useMoney();
  const header = layout?.header ?? DEFAULT_BILL_HEADER;
  const footer = layout?.footer ?? DEFAULT_BILL_FOOTER;
  const text = layout?.text ?? DEFAULT_BILL_TEXT;
  const overall = printTextScale(text);
  // A part's size relative to the overall size it sits in.
  const part = (name: BillTextPart) => ({ fontSize: `${printTextScale(text, name) / overall}em` });
  const date = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(printedAt);
  const rule = <div aria-hidden className="my-2 border-t border-dashed border-foreground" />;
  const contact = [header.phone, header.email, header.website].filter((v): v is string => !!v);

  return (
    <div
      className="font-mono text-xs leading-snug text-foreground print:text-sm"
      data-testid="receipt"
    >
      <div style={{ fontSize: `${overall}em` }} data-testid="receipt-text">
        <header
          className="flex flex-col items-center gap-0.5 text-center"
          style={part('header')}
          data-testid="bill-header"
        >
          {header.logo && (
            // A data URL from the settings (ADR 0025 §2); next/image can't optimize it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={header.logo}
              alt=""
              className="mb-1 max-h-24 max-w-[60%] object-contain grayscale"
              data-testid="bill-logo"
            />
          )}
          <p className="text-[1.3em] font-bold tracking-wide">{header.name ?? organizationName}</p>
          {contact.map((value) => (
            <p key={value} className="break-all">
              {value}
            </p>
          ))}
        </header>
        {rule}
        <div className="flex flex-col gap-0.5" data-testid="bill-middle">
          {order.waiterName && (
            <p data-testid="bill-waiter">{t('pos.bill.waiter', { name: order.waiterName })}</p>
          )}
          <p data-testid="bill-table">
            {order.covers
              ? t('pos.bill.tableAndGuests', { table: tableName, guests: String(order.covers) })
              : t('pos.ticket.table', { table: tableName })}
          </p>
          <p className="font-bold" data-testid="bill-number">
            {t('pos.bill.billNo', { number: order.number })}
          </p>
          {banner && (
            <p className="font-bold" data-testid="bill-banner">
              {banner}
            </p>
          )}
        </div>
        {rule}
        {cancelled && (
          <p
            className="my-1 text-center text-[1.45em] font-bold tracking-widest"
            data-testid="bill-cancelled"
          >
            {t('pos.bill.cancelledStamp')}
          </p>
        )}
        <ul className="flex flex-col gap-1" style={part('items')} data-testid="bill-items">
          {bill.map((l) => (
            <li key={l.key} data-testid="bill-line" data-name={l.name}>
              <p className="flex justify-between gap-2">
                <span>
                  {t('pos.order.lineQuantity', { quantity: String(l.quantity), name: l.name })}
                </span>
                <span className="shrink-0 tabular-nums">{money(l.total)}</span>
              </p>
              {l.quantity > 1 && <p className="pl-3">{`${l.quantity} × ${money(l.unitPrice)}`}</p>}
              {l.note && <p className="pl-3 italic">{l.note}</p>}
            </li>
          ))}
        </ul>
        {rule}
        <p
          className="flex justify-between gap-2 font-bold"
          style={{ fontSize: `${(1.3 * printTextScale(text, 'total')) / overall}em` }}
          data-testid="bill-total"
        >
          <span>{t('pos.bill.total')}</span>
          <span className="tabular-nums" data-testid="order-total">
            {money(order.total)}
          </span>
        </p>
        {rule}
        <footer
          className="flex flex-col items-center gap-0.5 text-center"
          style={part('footer')}
          data-testid="bill-footer"
        >
          {(footer.lines.length > 0 ? footer.lines : [t('pos.bill.thanks')]).map((line, i) => (
            <p key={i} className="text-[1.15em]" data-testid="bill-thanks">
              {line}
            </p>
          ))}
          <p className="mt-2 font-bold" data-testid="bill-interim-notice">
            {t('pos.bill.interimNotice')}
          </p>
          <p className="mt-1">{t('pos.bill.poweredBy', { product: productName })}</p>
          <p>{date}</p>
        </footer>
      </div>
    </div>
  );
}
