'use client';

import type { Order } from '@durby/shared';
import type { ReactNode } from 'react';
import { useT } from '../../app/labels-provider';
import type { BillLine } from '../../lib/pos/format';
import { cn } from '../../lib/utils';
import { useMoney } from './money';

/** A pending (not yet sent) item as the receipt shows it. */
export interface PendingLine {
  key: string;
  name: string;
  note: string;
  quantity: number;
  unitPrice: string;
  total: string;
}

export type ReceiptSelection = { kind: 'new' | 'sent'; key: string } | null;

/**
 * The bill as a till-receipt-style slip (docs/modules/pos.md → Printing), used for the preview on
 * the till and for printing: organization, table and guests, the order number, each item with its
 * total and "quantity × price", the total, thanks. No VAT breakdown and no TSE data (decision
 * 2026-11-02): it is a bill, not a receipt, and the footer says so (ADR 0016 §3).
 * `controls` renders under the selected line (preview only).
 */
export function Receipt({
  organizationName,
  tableName,
  order,
  bill,
  pending,
  printedAt,
  pendingTotal,
  grandTotal,
  selected,
  onSelect,
  controls,
}: {
  organizationName: string;
  tableName: string;
  order: Order | null;
  bill: BillLine[];
  pending: PendingLine[];
  printedAt: Date;
  pendingTotal: string;
  grandTotal: string;
  selected?: ReceiptSelection;
  onSelect?: (selection: ReceiptSelection) => void;
  controls?: ReactNode;
}) {
  const t = useT();
  const money = useMoney();
  const date = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(printedAt);
  const row = (label: string, value: string) => (
    <p className="flex justify-between gap-2">
      <span>{label}</span>
      <span>{value}</span>
    </p>
  );
  const line = (
    kind: 'new' | 'sent',
    l: {
      key: string;
      name: string;
      note: string | null;
      quantity: number;
      unitPrice: string;
      total: string;
    },
  ) => {
    const isSelected = selected?.kind === kind && selected.key === l.key;
    const body = (
      <>
        <span className="flex justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="font-semibold">{l.name}</span>
            {kind === 'new' && (
              <span className="rounded bg-primary px-1 text-[0.65rem] font-bold text-primary-foreground">
                {t('pos.order.newTag')}
              </span>
            )}
          </span>
          <span className="shrink-0 font-semibold tabular-nums">{money(l.total)}</span>
        </span>
        <span className="block pl-2">
          {l.quantity} × {money(l.unitPrice)}
        </span>
        {l.note && <span className="block pl-2 text-muted-foreground">{l.note}</span>}
      </>
    );
    return (
      <li
        key={`${kind}-${l.key}`}
        data-testid={kind === 'new' ? 'receipt-new' : 'bill-line'}
        data-name={l.name}
      >
        {onSelect ? (
          <button
            type="button"
            className={cn(
              'block w-full rounded px-2 py-1.5 text-left hover:bg-muted',
              isSelected && 'bg-muted',
            )}
            aria-expanded={isSelected}
            onClick={() => onSelect(isSelected ? null : { kind, key: l.key })}
          >
            {body}
          </button>
        ) : (
          <div className="px-2 py-1">{body}</div>
        )}
        {isSelected && controls}
      </li>
    );
  };

  return (
    <div
      className="font-mono text-xs leading-relaxed print:font-sans print:text-sm"
      data-testid="receipt"
    >
      <header className="flex flex-col items-center gap-0.5 pb-2 text-center">
        <p className="text-base font-bold tracking-wide print:text-lg">{organizationName}</p>
        <p className="text-muted-foreground">{t('pos.bill.slipTitle')}</p>
        <p aria-hidden className="w-1/2 border-t border-dashed border-border pt-1" />
        <p data-testid="bill-table">
          {order?.covers
            ? t('pos.bill.tableGuests', { table: tableName, guests: String(order.covers) })
            : t('pos.ticket.table', { table: tableName })}
        </p>
        {order && <p className="text-sm font-bold print:text-base">{order.number}</p>}
      </header>
      {bill.length === 0 && pending.length === 0 ? (
        <p className="px-2 py-6 text-center text-muted-foreground">{t('pos.order.cartEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-1 py-1">
          {bill.map((l) => line('sent', l))}
          {pending.map((l) => line('new', { ...l, note: l.note || null }))}
        </ul>
      )}
      <div className="mx-auto mt-1 w-1/2 border-t border-dashed border-border" />
      <div className="flex flex-col gap-0.5 px-2 pt-2">
        {order && pending.length > 0 && row(t('pos.bill.sent'), money(order.totals.gross))}
        {pending.length > 0 && row(t('pos.bill.toSend'), money(pendingTotal))}
        <p className="flex justify-between gap-2 pt-1 text-base font-bold print:text-lg">
          <span>{t('pos.bill.total')}</span>
          <span className="tabular-nums" data-testid="order-total">
            {money(grandTotal)}
          </span>
        </p>
      </div>
      <footer className="mt-3 flex flex-col items-center gap-1 text-center">
        <p className="text-sm print:text-base">{t('pos.bill.thanks')}</p>
        <p className="text-muted-foreground">{t('pos.bill.notReceipt')}</p>
        <div className="mt-2 text-muted-foreground" data-testid="bill-footer">
          {order && <p>{t('pos.ticket.order', { number: order.number })}</p>}
          <p>{date}</p>
        </div>
      </footer>
    </div>
  );
}
