'use client';

import type { Order } from '@durby/shared';
import type { ReactNode } from 'react';
import { useT } from '../../app/labels-provider';
import { type BillLine, rate } from '../../lib/pos/format';
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
 * The bill as a receipt-style slip (docs/modules/pos.md → Web), used for the preview on the till
 * and for printing. It is a bill, not a receipt: the footer says so (ADR 0016 §3).
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
        <span className="flex items-center gap-2">
          <span className="font-semibold">{l.name}</span>
          {kind === 'new' && (
            <span className="rounded bg-primary px-1 text-[0.65rem] font-bold text-primary-foreground">
              {t('pos.order.newTag')}
            </span>
          )}
        </span>
        {l.note && <span className="block text-muted-foreground">{l.note}</span>}
        <span className="flex justify-between gap-2">
          <span>
            {l.quantity} × {money(l.unitPrice)}
          </span>
          <span className="tabular-nums">{money(l.total)}</span>
        </span>
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
    <div className="font-mono text-xs leading-relaxed print:text-sm" data-testid="receipt">
      <div className="flex flex-col items-center gap-0.5 pb-2 text-center">
        <p className="text-sm font-bold print:text-base">{organizationName}</p>
        <p className="text-muted-foreground">{t('pos.bill.slipTitle')}</p>
      </div>
      <div className="border-y border-dashed border-border px-2 py-2">
        {row(t('pos.bill.date'), date)}
        {row(t('pos.bill.table'), tableName)}
        {order && row(t('pos.bill.order'), order.number)}
      </div>
      {bill.length === 0 && pending.length === 0 ? (
        <p className="px-2 py-6 text-center text-muted-foreground">{t('pos.order.cartEmpty')}</p>
      ) : (
        <ul className="flex flex-col py-1">
          {bill.map((l) => line('sent', l))}
          {pending.map((l) => line('new', { ...l, note: l.note || null }))}
        </ul>
      )}
      <div className="flex flex-col gap-0.5 border-t border-dashed border-border px-2 pt-2">
        {order &&
          order.totals.byTaxRate.map((r) => (
            <p key={r.taxRate} className="flex justify-between gap-2 text-muted-foreground">
              <span>{t('pos.bill.vatShort', { rate: rate(r.taxRate) })}</span>
              <span>
                {money(r.net)} + {money(r.tax)}
              </span>
            </p>
          ))}
        {order && pending.length > 0 && row(t('pos.bill.sent'), money(order.totals.gross))}
        {pending.length > 0 && row(t('pos.bill.toSend'), money(pendingTotal))}
        <p className="flex justify-between gap-2 pt-1 text-base font-bold">
          <span>{t('pos.bill.total')}</span>
          <span className="tabular-nums" data-testid="order-total">
            {money(grandTotal)}
          </span>
        </p>
      </div>
      <p className="border-t border-dashed border-border mt-2 pt-2 text-center text-muted-foreground">
        {t('pos.bill.notReceipt')}
      </p>
    </div>
  );
}
