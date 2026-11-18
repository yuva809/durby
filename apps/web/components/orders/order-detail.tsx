'use client';

import {
  ORDER_TEXT_MAX_LENGTH,
  SALES_ORDER_CANCELLABLE,
  type SalesOrder,
  type SalesOrderStatus,
} from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { cancelOrder, confirmOrder, loadOrder } from '../../lib/orders/api';
import { statusTone } from '../../lib/orders/form';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet';
import { ConfirmAction, Loaded } from '../users/common';
import { OrderDialog, type OrderFormData } from './order-dialog';

/** Theme tokens only (design rules): drafts in the primary colour, open work outlined, done filled. */
const TONE_CLASS: Record<ReturnType<typeof statusTone>, string> = {
  draft: 'border-primary text-primary',
  open: 'border-foreground/40 text-foreground',
  done: 'border-transparent bg-muted text-foreground',
  cancelled: 'line-through',
};

export function StatusBadge({ status }: { status: SalesOrderStatus }) {
  const t = useT();
  return (
    <Badge className={cn(TONE_CLASS[statusTone(status)])} data-testid="order-status">
      {t(`orders.status.${status}`)}
    </Badge>
  );
}

/**
 * One order in a side panel (docs/modules/orders.md → Web): customer, branch, items with totals and the timeline.
 * Drafts can be edited and confirmed (`orders.orders.edit`), orders up to packed cancelled (`orders.orders.delete`, ADR 0051).
 */
export function OrderDetail({
  orderId,
  onClose,
  onChanged,
  canEdit,
  canCancel,
  formData,
  formatTime,
}: {
  orderId: string | null;
  onClose: () => void;
  onChanged: () => void;
  canEdit: boolean;
  canCancel: boolean;
  formData: OrderFormData | null;
  formatTime: (iso: string) => string;
}) {
  const t = useT();
  const { store } = useAuth();
  const [order, reload] = useResource(orderId, () => loadOrder(store, orderId ?? ''));
  const changed = () => {
    reload();
    onChanged();
  };

  return (
    <Sheet open={orderId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        closeLabel={t('orders.detail.close')}
        className="w-full overflow-y-auto p-5 sm:max-w-xl"
        data-testid="order-detail"
      >
        <Loaded resource={order} reload={reload}>
          {(o) => (
            <Detail
              order={o}
              canEdit={canEdit}
              canCancel={canCancel}
              formData={formData}
              onChanged={changed}
              formatTime={formatTime}
            />
          )}
        </Loaded>
        {order.status !== 'ready' && (
          // Radix needs a title while the order loads; the loaded one brings its own.
          <SheetTitle>{t('platform.nav.orderHistory')}</SheetTitle>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Detail({
  order,
  canEdit,
  canCancel,
  formData,
  onChanged,
  formatTime,
}: {
  order: SalesOrder;
  canEdit: boolean;
  canCancel: boolean;
  formData: OrderFormData | null;
  onChanged: () => void;
  formatTime: (iso: string) => string;
}) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const confirmAction = useActionKey();
  const none = t('orders.detail.none');
  const facts: [string, string][] = [
    [t('orders.detail.customer'), order.customerName],
    [t('orders.detail.warehouse'), `${order.locationName} · ${order.warehouseName}`],
    [t('orders.detail.requestedDate'), order.requestedDate ?? none],
    [t('orders.detail.deliveryAddress'), order.deliveryAddress ?? none],
    [t('orders.detail.note'), order.note ?? none],
    ...(order.dispatchedAt
      ? ([
          [t('orders.detail.dispatchedAt'), formatTime(order.dispatchedAt)],
          [
            t('orders.detail.driver'),
            [order.driverName, order.driverPhone].filter(Boolean).join(' · ') || none,
          ],
          [t('orders.detail.vehicle'), order.vehicle ?? none],
        ] as [string, string][])
      : []),
    ...(order.deliveredAt
      ? ([[t('orders.detail.deliveredAt'), formatTime(order.deliveredAt)]] as [string, string][])
      : []),
  ];
  const picked = order.lines.some((l) => l.pickedQuantity !== null);

  return (
    <div className="flex flex-col gap-5 pr-8">
      <div className="flex flex-wrap items-center gap-3">
        <SheetTitle className="not-sr-only text-xl font-semibold">
          {t('orders.detail.title', { number: order.number })}
        </SheetTitle>
        <StatusBadge status={order.status} />
      </div>
      <SheetDescription className="sr-only">{order.customerName}</SheetDescription>

      {(canEdit || canCancel) && (
        <div className="flex flex-wrap gap-2" data-testid="order-actions">
          {canEdit && order.status === 'draft' && formData && (
            <OrderDialog order={order} data={formData} onDone={onChanged} />
          )}
          {canEdit && order.status === 'draft' && (
            <ConfirmAction
              testId="order-confirm"
              trigger={t('orders.detail.confirm')}
              title={t('orders.detail.confirmTitle', { number: order.number })}
              description={t('orders.detail.confirmDescription')}
              confirm={t('orders.detail.confirm')}
              run={() => confirmOrder(store, confirmAction, order.id)}
              onDone={onChanged}
            />
          )}
          {canCancel && SALES_ORDER_CANCELLABLE.includes(order.status) && (
            <CancelOrder order={order} onDone={onChanged} />
          )}
        </div>
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="order-lines-heading" className="flex flex-col gap-2">
        <h3 id="order-lines-heading" className="font-medium">
          {t('orders.detail.lines')}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="order-detail-lines">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 font-medium">{t('orders.detail.item')}</th>
                <th className="py-1 text-right font-medium">{t('orders.detail.quantity')}</th>
                {picked && (
                  <th className="py-1 text-right font-medium">{t('orders.detail.picked')}</th>
                )}
                <th className="py-1 text-right font-medium">{t('orders.detail.unitPrice')}</th>
                <th className="py-1 text-right font-medium">{t('orders.detail.lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className="border-b last:border-0">
                  <td className="py-1.5">{line.itemName}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {`${line.quantity.replace(/\.?0+$/, '')} ${line.unit}`}
                  </td>
                  {picked && (
                    <td className="py-1.5 text-right tabular-nums" data-testid="order-line-picked">
                      {line.pickedQuantity === null
                        ? none
                        : line.pickedQuantity.replace(/\.?0+$/, '') || '0'}
                    </td>
                  )}
                  <td className="py-1.5 text-right tabular-nums">{money(line.unitPrice)}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(line.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td className="pt-2" colSpan={picked ? 4 : 3}>
                  {t('orders.detail.total')}
                </td>
                <td className="pt-2 text-right tabular-nums" data-testid="order-detail-total">
                  {money(order.total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section aria-labelledby="order-timeline-heading" className="flex flex-col gap-2">
        <h3 id="order-timeline-heading" className="font-medium">
          {t('orders.detail.timeline')}
        </h3>
        <ol className="flex flex-col gap-2 border-l pl-4" data-testid="order-timeline">
          {order.events.map((event) => (
            <li key={event.id} className="relative text-sm">
              <span
                aria-hidden
                className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary"
              />
              <span className="font-medium">{t(`orders.status.${event.status}`)}</span>
              <span className="text-muted-foreground"> · {formatTime(event.createdAt)}</span>
              {event.note && <p className="text-muted-foreground">{event.note}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function CancelOrder({ order, onDone }: { order: SalesOrder; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      trigger={t('orders.detail.cancel')}
      triggerVariant="outline"
      testId="order-cancel"
      title={t('orders.detail.cancelTitle', { number: order.number })}
      submitLabel={t('orders.detail.cancelConfirm')}
      onOpen={() => setReason('')}
      submit={() =>
        cancelOrder(store, action, order.id, reason.trim() ? { reason: reason.trim() } : {})
      }
      onDone={onDone}
    >
      <Field id={`${id}-reason`} label={t('orders.detail.cancelReason')} problem={null}>
        <Input
          id={`${id}-reason`}
          value={reason}
          maxLength={ORDER_TEXT_MAX_LENGTH}
          onChange={(e) => setReason(e.target.value)}
          data-testid="order-cancel-reason"
        />
      </Field>
    </FormDialog>
  );
}
