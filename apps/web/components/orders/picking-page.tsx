'use client';

import { pickedQuantitySchema, type SalesOrder, type SalesOrderSummary } from '@durby/shared';
import { PackageCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadWarehouses } from '../../lib/inventory/api';
import { loadOrder, loadOrders, pickOrder, startPicking } from '../../lib/orders/api';
import { compareQuantity } from '../../lib/orders/form';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { FormDialog } from '../form-dialog';
import { MoneyProvider } from '../pos/money';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { TransfersPicking } from '../requests/transfers-picking';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { StatusBadge } from './order-detail';

/** The queue holds every order waiting for its goods; a warehouse rarely has more than this at once. */
const QUEUE_LIMIT = 200;

/**
 * /picking (docs/modules/orders.md → Step 3, ADR 0044): confirmed orders waiting for their goods, oldest first. "Pick"
 * records what came off the shelves; confirming books one goods issue and the order is packed (ready to dispatch).
 */
export function PickingPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('orders.picking.use'))
    return <NoAccess title="platform.nav.picking" />;
  return (
    <MoneyProvider>
      <Picking organizationId={session.activeOrganizationId} />
    </MoneyProvider>
  );
}

function Picking({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [warehouseId, setWarehouseId] = useState('');
  const [queue, reload] = useResource(organizationId, () =>
    loadOrders(store, { status: ['confirmed', 'picking'] }, undefined, QUEUE_LIMIT),
  );
  const [warehouses] = useResource(organizationId, () => loadWarehouses(store));
  const [locations] = useResource(organizationId, () => loadLocations(store));
  const locationName = (lid: string) =>
    (locations.status === 'ready' ? locations.data.find((l) => l.id === lid)?.name : null) ?? '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.nav.picking')}</h1>
          <p className="text-muted-foreground">{t('orders.picking.intro')}</p>
        </div>
        {warehouses.status === 'ready' && warehouses.data.length > 1 && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-warehouse`}>{t('orders.picking.warehouse')}</Label>
            <Select
              id={`${id}-warehouse`}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              data-testid="picking-warehouse"
              className="w-60"
            >
              <option value="">{t('orders.picking.allWarehouses')}</option>
              {warehouses.data
                .filter((w) => w.archivedAt === null)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {`${locationName(w.locationId)} · ${w.name}`}
                  </option>
                ))}
            </Select>
          </div>
        )}
      </div>
      <TransfersPicking organizationId={organizationId} />
      <h2 className="text-lg font-semibold">{t('platform.nav.orderHistory')}</h2>
      <Loaded resource={queue} reload={reload}>
        {(page) => {
          // Oldest first: the order that has waited longest is picked first.
          const orders = [...page.data]
            .reverse()
            .filter((o) => warehouseId === '' || o.warehouseId === warehouseId);
          if (orders.length === 0) {
            return (
              <Card
                className="flex flex-col items-center gap-2 px-6 py-12 text-center"
                data-testid="picking-empty"
              >
                <PackageCheck aria-hidden className="size-8 text-muted-foreground" />
                <p className="text-muted-foreground">{t('orders.picking.empty')}</p>
              </Card>
            );
          }
          return (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="picking-queue">
              {orders.map((order) => (
                <PickCard key={order.id} order={order} onDone={reload} />
              ))}
            </ul>
          );
        }}
      </Loaded>
    </div>
  );
}

function PickCard({ order, onDone }: { order: SalesOrderSummary; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <li>
      <Card className="flex h-full flex-col gap-3 p-4" data-testid="picking-card">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col">
            <span className="font-semibold">{order.number}</span>
            <span className="text-sm">{order.customerName}</span>
          </div>
          <StatusBadge status={order.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {`${order.locationName} · ${order.warehouseName}`}
          <br />
          {t('orders.picking.items', { count: String(order.lineCount) })}
          {order.requestedDate &&
            ` · ${t('orders.picking.requested', { date: order.requestedDate })}`}
        </p>
        <div className="mt-auto flex flex-wrap gap-2">
          {order.status === 'confirmed' && (
            <ConfirmAction
              testId="picking-start"
              trigger={t('orders.picking.start')}
              title={t('orders.picking.title', { number: order.number })}
              description={t('orders.picking.intro')}
              confirm={t('orders.picking.start')}
              run={() => startPicking(store, action, order.id)}
              onDone={onDone}
            />
          )}
          <PickDialog order={order} onDone={onDone} />
        </div>
      </Card>
    </li>
  );
}

/** Text without trailing zeros: "3.000" → "3", "1.500" → "1.5". */
const short = (quantity: string) => quantity.replace(/\.?0+$/, '') || '0';

function PickDialog({ order, onDone }: { order: SalesOrderSummary; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [openCount, setOpenCount] = useState(0);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const [detail] = useResource<SalesOrder>(
    openCount === 0 ? null : `${order.id}:${openCount}`,
    () =>
      loadOrder(store, order.id).then((result) => {
        if (result.ok) {
          setPicked(Object.fromEntries(result.data.lines.map((l) => [l.id, short(l.quantity)])));
        }
        return result;
      }),
  );
  const lines = detail.status === 'ready' ? detail.data.lines : [];
  const valid = (full: SalesOrder['lines']) =>
    full.every((l) => {
      const value = (picked[l.id] ?? '').trim();
      return (
        pickedQuantitySchema.safeParse(value).success &&
        (compareQuantity(value, l.quantity) ?? 1) <= 0
      );
    });
  const shortCount = lines.filter(
    (l) => (compareQuantity(picked[l.id] ?? '0', l.quantity) ?? 0) < 0,
  ).length;

  return (
    <FormDialog
      trigger={t('orders.picking.pick')}
      triggerVariant={order.status === 'picking' ? 'default' : 'outline'}
      testId="picking-pick"
      title={t('orders.picking.title', { number: order.number })}
      submitLabel={t('orders.picking.submit')}
      wide
      onOpen={() => {
        setChecked(false);
        setPicked({});
        setOpenCount((n) => n + 1);
      }}
      submit={() => {
        setChecked(true);
        if (detail.status !== 'ready' || !valid(lines)) return null;
        return pickOrder(store, action, order.id, {
          lines: lines.map((l) => ({ lineId: l.id, quantity: (picked[l.id] ?? '0').trim() })),
        });
      }}
      onDone={onDone}
    >
      <Loaded resource={detail} reload={() => setOpenCount((n) => n + 1)}>
        {(full) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t('orders.picking.stockNote', { warehouse: full.warehouseName })}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="pick-lines">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 font-medium">{t('orders.detail.item')}</th>
                    <th className="py-1 text-right font-medium">{t('orders.picking.ordered')}</th>
                    <th className="py-1 text-right font-medium">{t('orders.picking.picked')}</th>
                  </tr>
                </thead>
                <tbody>
                  {full.lines.map((line) => (
                    <tr key={line.id} className="border-b last:border-0">
                      <td className="py-1.5">{line.itemName}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {`${short(line.quantity)} ${line.unit}`}
                      </td>
                      <td className="py-1.5 text-right">
                        <Input
                          inputMode="decimal"
                          className="ml-auto w-24 text-right"
                          value={picked[line.id] ?? ''}
                          aria-label={t('orders.picking.pickedOf', { name: line.itemName })}
                          onChange={(e) =>
                            setPicked((p) => ({
                              ...p,
                              [line.id]: e.target.value.replace(',', '.'),
                            }))
                          }
                          data-testid="pick-quantity"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() =>
                setPicked(Object.fromEntries(full.lines.map((l) => [l.id, short(l.quantity)])))
              }
              data-testid="pick-all"
            >
              {t('orders.picking.all')}
            </Button>
            {checked && !valid(full.lines) && (
              <p role="alert" className="text-sm text-destructive">
                {t('orders.picking.invalid')}
              </p>
            )}
            {shortCount > 0 && valid(full.lines) && (
              <p className="text-sm text-muted-foreground" data-testid="pick-short">
                {t('orders.picking.short', { count: String(shortCount) })}
              </p>
            )}
          </div>
        )}
      </Loaded>
    </FormDialog>
  );
}
