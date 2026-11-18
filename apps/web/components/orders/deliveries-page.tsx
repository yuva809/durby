'use client';

import type { ReactNode } from 'react';

import { ORDER_TEXT_MAX_LENGTH, type SalesOrderSummary } from '@durby/shared';
import { useId, useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { deliverOrder, dispatchOrder, loadOrders, returnOrder } from '../../lib/orders/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Field, FormDialog } from '../form-dialog';
import { MoneyProvider } from '../pos/money';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { TransfersPicking } from '../requests/transfers-picking';
import { Loaded, NoAccess } from '../users/common';
import { BranchDeliveries } from '../requests/branch-deliveries';

const BOARD_LIMIT = 200;
const RECENT_DAYS = 7;

/**
 * /deliveries, Delivery Tracking (docs/modules/orders.md → Step 3, ADR 0044): a board of packed orders (dispatch with
 * driver and vehicle), orders on the way (delivered, or came back with the goods booked back in) and what was
 * delivered in the last 7 days. A status board, not routing.
 */
export function DeliveriesPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = session.activePermissions;
  const deliveries =
    permissions.includes('orders.delivery.use') || permissions.includes('orders.delivery.assign');
  // A branch follows its own requests to its door (ADR 0059).
  if (!deliveries && permissions.includes('orders.requests.receive'))
    return <BranchDeliveries organizationId={session.activeOrganizationId} />;
  if (!deliveries) return <NoAccess title="platform.nav.deliveries" />;
  return (
    <MoneyProvider>
      {permissions.includes('orders.delivery.assign') && (
        <div className="mb-6">
          <TransfersPicking organizationId={session.activeOrganizationId} initialTab="packed" />
        </div>
      )}
      <Deliveries
        organizationId={session.activeOrganizationId}
        canDeliver={permissions.includes('orders.delivery.use')}
      />
    </MoneyProvider>
  );
}

function Deliveries({
  organizationId,
  canDeliver,
}: {
  organizationId: string | null;
  /** Sales-order steps (dispatch, delivered, came back) need orders.delivery.use. */
  canDeliver: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  // Fixed per visit, so the board's key (and its request) stays the same between renders.
  const [since] = useState(() => new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString());
  const [open, reloadOpen] = useResource(organizationId, () =>
    loadOrders(store, { status: ['packed', 'dispatched'] }, undefined, BOARD_LIMIT),
  );
  const [done, reloadDone] = useResource(organizationId, () =>
    loadOrders(store, { status: 'delivered', from: since }, undefined, BOARD_LIMIT),
  );
  const reload = () => {
    reloadOpen();
    reloadDone();
  };
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    [],
  );
  const formatTime = (iso: string | null) => (iso ? time.format(new Date(iso)) : '');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('platform.nav.deliveries')}</h1>
        <p className="text-muted-foreground">{t('orders.delivery.intro')}</p>
      </div>
      <Loaded resource={open} reload={reloadOpen}>
        {(openPage) => {
          // Oldest first in each column: the longest waiting comes first.
          const oldestFirst = [...openPage.data].reverse();
          const ready = oldestFirst.filter((o) => o.status === 'packed');
          const onTheWay = oldestFirst.filter((o) => o.status === 'dispatched');
          return (
            <div className="grid gap-4 lg:grid-cols-3">
              <Column
                title={t('orders.delivery.ready')}
                testId="delivery-ready"
                count={ready.length}
              >
                {ready.map((order) => (
                  <DeliveryCard key={order.id} order={order}>
                    {canDeliver && <DispatchDialog order={order} onDone={reload} />}
                  </DeliveryCard>
                ))}
              </Column>
              <Column
                title={t('orders.delivery.onTheWay')}
                testId="delivery-on-the-way"
                count={onTheWay.length}
              >
                {onTheWay.map((order) => (
                  <DeliveryCard
                    key={order.id}
                    order={order}
                    extra={[
                      order.driverName
                        ? t('orders.delivery.driver', { name: order.driverName })
                        : '',
                      t('orders.delivery.since', { time: formatTime(order.dispatchedAt) }),
                    ]}
                  >
                    {canDeliver && <NoteDialog kind="deliver" order={order} onDone={reload} />}
                    {canDeliver && <NoteDialog kind="return" order={order} onDone={reload} />}
                  </DeliveryCard>
                ))}
              </Column>
              <Loaded resource={done} reload={reloadDone}>
                {(donePage) => (
                  <Column
                    title={t('orders.delivery.delivered')}
                    testId="delivery-delivered"
                    count={donePage.data.length}
                  >
                    {donePage.data.map((order) => (
                      <DeliveryCard
                        key={order.id}
                        order={order}
                        extra={[t('orders.delivery.at', { time: formatTime(order.deliveredAt) })]}
                      />
                    ))}
                  </Column>
                )}
              </Loaded>
            </div>
          );
        }}
      </Loaded>
    </div>
  );
}

function Column({
  title,
  count,
  testId,
  children,
}: {
  title: string;
  count: number;
  testId: string;
  children: ReactNode;
}) {
  const t = useT();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3"
      data-testid={testId}
    >
      <h2 id={headingId} className="flex items-center justify-between font-medium">
        {title}
        <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">{t('orders.delivery.emptyColumn')}</p>
      ) : (
        <ul className="flex flex-col gap-2">{children}</ul>
      )}
    </section>
  );
}

function DeliveryCard({
  order,
  extra = [],
  children,
}: {
  order: SalesOrderSummary;
  extra?: string[];
  children?: ReactNode;
}) {
  return (
    <li>
      <Card
        className="flex flex-col gap-2 p-3"
        data-testid="delivery-card"
        data-number={order.number}
      >
        <div className="flex flex-col">
          <span className="font-semibold">{order.number}</span>
          <span className="text-sm">{order.customerName}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {[order.deliveryAddress, `${order.locationName} · ${order.warehouseName}`, ...extra]
            .filter(Boolean)
            .map((text) => (
              <span key={text} className="block">
                {text}
              </span>
            ))}
        </p>
        {children && <div className="flex flex-wrap gap-2">{children}</div>}
      </Card>
    </li>
  );
}

function DispatchDialog({ order, onDone }: { order: SalesOrderSummary; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [fields, setFields] = useState({ driverName: '', driverPhone: '', vehicle: '', note: '' });
  const input = (key: keyof typeof fields, label: string, max: number, type = 'text') => (
    <Field id={`${id}-${key}`} label={label} problem={null}>
      <Input
        id={`${id}-${key}`}
        type={type}
        value={fields[key]}
        maxLength={max}
        onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
        data-testid={`dispatch-${key}`}
      />
    </Field>
  );
  return (
    <FormDialog
      trigger={t('orders.delivery.dispatch')}
      triggerVariant="default"
      testId="delivery-dispatch"
      title={t('orders.delivery.dispatchTitle', { number: order.number })}
      submitLabel={t('orders.delivery.dispatch')}
      onOpen={() => setFields({ driverName: '', driverPhone: '', vehicle: '', note: '' })}
      submit={() => {
        const text = (value: string) => (value.trim() === '' ? undefined : value.trim());
        return dispatchOrder(store, action, order.id, {
          driverName: text(fields.driverName),
          driverPhone: text(fields.driverPhone),
          vehicle: text(fields.vehicle),
          note: text(fields.note),
        });
      }}
      onDone={onDone}
    >
      {input('driverName', t('orders.delivery.driverName'), 80)}
      {input('driverPhone', t('orders.delivery.driverPhone'), 40, 'tel')}
      {input('vehicle', t('orders.delivery.vehicle'), 40)}
      {input('note', t('orders.delivery.note'), ORDER_TEXT_MAX_LENGTH)}
    </FormDialog>
  );
}

/** Delivered (a note: who received it) or came back (why; the goods go back in). */
function NoteDialog({
  kind,
  order,
  onDone,
}: {
  kind: 'deliver' | 'return';
  order: SalesOrderSummary;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [note, setNote] = useState('');
  const deliver = kind === 'deliver';
  return (
    <FormDialog
      trigger={t(deliver ? 'orders.delivery.deliver' : 'orders.delivery.return')}
      triggerVariant={deliver ? 'default' : 'outline'}
      testId={deliver ? 'delivery-deliver' : 'delivery-return'}
      title={t(deliver ? 'orders.delivery.deliverTitle' : 'orders.delivery.returnTitle', {
        number: order.number,
      })}
      submitLabel={t(deliver ? 'orders.delivery.deliver' : 'orders.delivery.return')}
      onOpen={() => setNote('')}
      submit={() => {
        const body = note.trim() ? { note: note.trim() } : {};
        return deliver
          ? deliverOrder(store, action, order.id, body)
          : returnOrder(store, action, order.id, body);
      }}
      onDone={onDone}
    >
      {!deliver && (
        <p className="text-sm text-muted-foreground">
          {t('orders.delivery.returnHint', { warehouse: order.warehouseName })}
        </p>
      )}
      <Field
        id={`${id}-note`}
        label={t(deliver ? 'orders.delivery.receivedBy' : 'orders.delivery.returnReason')}
        problem={null}
      >
        <Input
          id={`${id}-note`}
          value={note}
          maxLength={ORDER_TEXT_MAX_LENGTH}
          onChange={(e) => setNote(e.target.value)}
          data-testid="delivery-note"
        />
      </Field>
    </FormDialog>
  );
}
