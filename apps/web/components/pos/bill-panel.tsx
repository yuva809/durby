'use client';

import type { Order, SendTicketResponse } from '@durby/shared';
import { Printer } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { closeOrder, voidLines } from '../../lib/pos/api';
import { billLines, rate } from '../../lib/pos/format';
import { useActionKey } from '../../lib/use-action-key';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ConfirmAction } from '../users/common';
import { useMoney } from './money';

export interface OrderAccess {
  canTake: boolean;
  canVoid: boolean;
  canClose: boolean;
}

/**
 * The order as a bill (docs/modules/pos.md → Web): items combined across tickets, the VAT split and
 * the total, the order actions, and the kitchen tickets behind a disclosure for reprints.
 */
export function BillPanel({
  order,
  access,
  onReprint,
  onVoided,
  onClosed,
}: {
  order: Order;
  access: OrderAccess;
  onReprint: (ticketId: string) => void;
  onVoided: (response: SendTicketResponse) => void;
  onClosed: () => void;
}) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const closeAction = useActionKey();
  const lines = billLines(order);

  return (
    <div className="flex flex-col gap-4" data-testid="order-view">
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pos.order.noOrder')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {lines.map((line) => (
            <li key={line.key} className="flex justify-between gap-3 py-2" data-testid="bill-line">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {t('pos.order.lineQuantity', {
                    quantity: String(line.quantity),
                    name: line.name,
                  })}
                </span>
                {line.note && <span className="text-sm text-muted-foreground">{line.note}</span>}
                {line.quantity > 1 && (
                  <span className="text-xs text-muted-foreground">
                    {t('pos.bill.unitPrice', { price: money(line.unitPrice) })}
                  </span>
                )}
              </span>
              <span className="tabular-nums">{money(line.total)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1 border-t-2 border-foreground pt-3">
        {order.totals.byTaxRate.map((r) => (
          <p key={r.taxRate} className="text-sm text-muted-foreground">
            {t('pos.bill.vatLine', { rate: rate(r.taxRate), net: money(r.net), tax: money(r.tax) })}
          </p>
        ))}
        <p className="flex items-baseline justify-between gap-2 pt-1">
          <span className="text-lg font-semibold">{t('pos.order.total')}</span>
          <span className="text-2xl font-bold tabular-nums" data-testid="order-total">
            {money(order.totals.gross)}
          </span>
        </p>
      </div>

      {order.status === 'open' && (access.canVoid || access.canClose) && (
        <div className="flex flex-wrap gap-2">
          {access.canVoid && order.totals.itemCount > 0 && (
            <VoidDialog order={order} onVoided={onVoided} />
          )}
          {access.canClose && (
            <ConfirmAction
              testId="close-order"
              trigger={t('pos.order.close')}
              title={t('pos.order.closeTitle', { number: order.number })}
              description={t('pos.order.closeDescription')}
              confirm={t('pos.order.close')}
              run={() => closeOrder(store, closeAction, order.id)}
              onDone={onClosed}
            />
          )}
        </div>
      )}

      <details className="group rounded-md border border-border">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
          {t('pos.bill.tickets', { count: String(order.tickets.length) })}
        </summary>
        <div className="flex flex-col gap-3 border-t border-border p-3">
          {order.tickets.map((ticket) => (
            <section key={ticket.id} className="flex flex-col gap-1" data-testid="order-ticket">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">
                  {t(ticket.kind === 'void' ? 'pos.order.voidTicket' : 'pos.order.ticket', {
                    sequence: String(ticket.sequence),
                  })}
                </h3>
                <Button variant="ghost" className="gap-1" onClick={() => onReprint(ticket.id)}>
                  <Printer aria-hidden className="size-4" />
                  {t('pos.order.reprint')}
                </Button>
              </div>
              <ul className="flex flex-col gap-0.5 text-sm">
                {ticket.lines.map((line) => (
                  <li
                    key={line.id}
                    className={cn(
                      'flex justify-between gap-2',
                      line.quantity > 0 &&
                        line.remaining === 0 &&
                        'text-muted-foreground line-through',
                      line.quantity < 0 && 'text-destructive',
                    )}
                  >
                    <span>
                      {t('pos.order.lineQuantity', {
                        quantity: String(line.quantity),
                        name: line.productName,
                      })}
                    </span>
                    <span className="tabular-nums">{money(line.total)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </details>
    </div>
  );
}

/** Choose how many of each sent item to void; prints the VOID ticket. */
function VoidDialog({
  order,
  onVoided,
}: {
  order: Order;
  onVoided: (response: SendTicketResponse) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const lines = order.tickets.flatMap((ticket) => ticket.lines.filter((l) => l.remaining > 0));
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <FormDialog
      trigger={t('pos.order.void')}
      triggerVariant="outline"
      testId="void-items"
      title={t('pos.order.voidTitle')}
      onOpen={() => {
        setCounts({});
        setProblem(null);
      }}
      submit={() => {
        const chosen = lines
          .map((line) => ({ lineId: line.id, quantity: Number(counts[line.id] ?? '0') }))
          .filter((l) => l.quantity > 0);
        const invalid = lines.some((line) => {
          const n = Number(counts[line.id] ?? '0');
          return !Number.isInteger(n) || n < 0 || n > line.remaining;
        });
        if (chosen.length === 0 || invalid) {
          setProblem(t('pos.order.voidNothing'));
          return null;
        }
        setProblem(null);
        return voidLines(store, action, order.id, { lines: chosen }).then((result) => {
          if (result.ok && result.data) onVoided(result.data);
          return result;
        });
      }}
      onDone={() => undefined}
    >
      <p className="text-sm text-muted-foreground">{t('pos.order.voidDescription')}</p>
      {lines.map((line) => (
        <Field
          key={line.id}
          id={`${id}-${line.id}`}
          label={t('pos.order.lineQuantity', {
            quantity: String(line.remaining),
            name: line.productName,
          })}
          problem={null}
        >
          <Input
            id={`${id}-${line.id}`}
            inputMode="numeric"
            aria-label={t('pos.order.voidQuantity', { name: line.productName })}
            value={counts[line.id] ?? ''}
            onChange={(e) => setCounts((c) => ({ ...c, [line.id]: e.target.value }))}
          />
        </Field>
      ))}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </FormDialog>
  );
}
