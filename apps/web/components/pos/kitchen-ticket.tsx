'use client';

import type { KitchenTicket } from '@durby/shared';
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
 * The kitchen ticket (docs/modules/pos.md → Step 3): table, order and ticket number, time, items
 * with notes, no prices. A void ticket says so in large letters.
 */
export function KitchenTicketView({
  ticket,
  tableName,
  orderNumber,
}: {
  ticket: KitchenTicket;
  tableName: string;
  orderNumber: string;
}) {
  const t = useT();
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
    new Date(ticket.createdAt),
  );
  return (
    <article className="flex flex-col gap-2 p-2 text-foreground" data-testid="kitchen-ticket">
      <header className="flex flex-col gap-1 border-b border-border pb-2">
        <p className="text-sm">{t('pos.ticket.title')}</p>
        {ticket.kind === 'void' && <p className="text-3xl font-bold">{t('pos.ticket.void')}</p>}
        <p className="text-2xl font-bold">{t('pos.ticket.table', { table: tableName })}</p>
        <p className="text-sm">
          {t('pos.ticket.order', { number: orderNumber })} ·{' '}
          {t('pos.ticket.number', { sequence: String(ticket.sequence) })} · {time}
        </p>
      </header>
      <ul className="flex flex-col gap-2">
        {ticket.lines.map((line) => (
          <li key={line.id}>
            <p className="text-lg font-semibold">
              {t('pos.order.lineQuantity', {
                quantity: String(Math.abs(line.quantity)),
                name: line.productName,
              })}
            </p>
            {line.note && <p className="text-base">{line.note}</p>}
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
