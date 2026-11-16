'use client';

import {
  DEFAULT_TICKET_TEXT,
  type KitchenTicket,
  printTextScale,
  type TicketText,
} from '@durby/shared';
import type { BillLine } from '../../lib/pos/format';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../app/labels-provider';

/**
 * Renders `children` into `#print-root`, the only element shown in print (app/globals.css). Created
 * on first use, so pages without tickets add nothing. Mounted only after a user action, so always in
 * the browser; the `document` check keeps a server render harmless anyway.
 */
export function PrintRoot({ children }: { children: ReactNode }) {
  const [root] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null;
    let el = document.getElementById('print-root');
    if (!el) {
      el = document.createElement('div');
      el.id = 'print-root';
      document.body.appendChild(el);
    }
    return el;
  });
  return root ? createPortal(children, root) : null;
}

/**
 * The kitchen or bar ticket (docs/modules/pos.md → Step 3, Printing, Stations): laid out like a
 * kitchen printer's slip on the 80 mm roll: "Dine in" (a bar ticket: "BAR"), the organization and
 * time, the table and order in large type, then the new items with their quantity in a column. No
 * prices; tickets don't name the waiter (ADR 0016, 0025). A void ticket says so in large letters.
 * Text sizes from `pos.ticketText`: the overall size, and the item lines their own if set.
 */
export function KitchenTicketView({
  ticket,
  tableName,
  orderNumber,
  organizationName,
  text = DEFAULT_TICKET_TEXT,
}: {
  ticket: KitchenTicket;
  tableName: string;
  orderNumber: string;
  organizationName: string;
  /** Null or absent: the default sizes. */
  text?: TicketText | null;
}) {
  const t = useT();
  const sizes = text ?? DEFAULT_TICKET_TEXT;
  const overall = printTextScale(sizes);
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
    new Date(ticket.createdAt),
  );
  return (
    <article
      className="flex flex-col gap-3 p-2 font-sans text-foreground"
      style={{ fontSize: `${overall}rem` }}
      data-testid="kitchen-ticket"
      data-station={ticket.station}
    >
      <header className="flex flex-col items-center gap-1 text-center">
        <p className="text-[1.25em] font-bold">
          {t(ticket.station === 'bar' ? 'pos.ticket.bar' : 'pos.ticket.dineIn')}
        </p>
        <p className="text-[0.875em]">
          {t('pos.ticket.header', { organization: organizationName, time })}
        </p>
        <p className="mt-1 text-[1.5em] font-bold" data-testid="kitchen-ticket-table">
          {t('pos.ticket.table', { table: tableName })}
        </p>
        {/* Order numbers are long ("ORD-2026-000505"): their own line, so the table stays on one. */}
        <p className="font-semibold">
          {t('pos.ticket.orderTicket', {
            number: orderNumber,
            sequence: String(ticket.sequence),
          })}
        </p>
      </header>
      <div className="border-t border-dashed border-border pt-2 text-center">
        {ticket.kind === 'void' ? (
          <p className="text-[1.875em] font-bold">{t('pos.ticket.void')}</p>
        ) : (
          <p className="text-[1.25em] font-bold">{t('pos.ticket.new')}</p>
        )}
      </div>
      <ul
        className="flex flex-col gap-2"
        style={{ fontSize: `${printTextScale(sizes, 'items') / overall}em` }}
        data-testid="kitchen-ticket-items"
      >
        {ticket.lines.map((line) => (
          <li key={line.id} className="grid grid-cols-[2.5ch_1fr] gap-x-2 text-[1.25em]">
            <span className="font-semibold tabular-nums">{Math.abs(line.quantity)}</span>
            <span>{line.productName}</span>
            {line.note && <span className="col-start-2 text-[0.8em] italic">{line.note}</span>}
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * The order as waiters print it (docs/modules/pos.md → Printing): what the table has ordered, combined
 * across tickets, with quantities and notes. No prices, VAT or totals: the bill with amounts is for
 * those holding `pos.bills.print`.
 */
export function OrderSlip({
  organizationName,
  tableName,
  orderNumber,
  lines,
  printedAt,
}: {
  organizationName: string;
  tableName: string;
  orderNumber: string;
  lines: BillLine[];
  printedAt: Date;
}) {
  const t = useT();
  const time = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(printedAt);
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  return (
    <article
      className="flex flex-col gap-2 p-2 font-mono text-sm text-foreground"
      data-testid="order-slip"
    >
      <header className="flex flex-col items-center gap-0.5 border-b border-dashed border-border pb-2 text-center">
        <p className="font-bold">{organizationName}</p>
        <p>{t('pos.slip.title')}</p>
        <p className="text-lg font-bold">{t('pos.ticket.table', { table: tableName })}</p>
        <p>
          {t('pos.ticket.order', { number: orderNumber })} · {time}
        </p>
      </header>
      <ul className="flex flex-col gap-1">
        {lines.map((line) => (
          <li key={line.key}>
            <p className="font-semibold">
              {t('pos.order.lineQuantity', { quantity: String(line.quantity), name: line.name })}
            </p>
            {line.note && <p>{line.note}</p>}
          </li>
        ))}
      </ul>
      <p className="border-t border-dashed border-border pt-2 text-center">
        {t('pos.order.itemCount', { count: String(count) })}
      </p>
    </article>
  );
}
