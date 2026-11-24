'use client';

import type { ItemMovement, StockItem, Warehouse } from '@durby/shared';
import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  loadItemMovements,
  loadStock,
  loadStockCategories,
  loadStockItems,
  loadWarehouses,
} from '../../lib/inventory/api';
import { shortQuantity } from '../../lib/inventory/format';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { ItemDialog } from './items-tab';

/**
 * One stock item's page: its name, state and category; Edit (with its stock quantity); and its activity, the ledger of
 * every movement newest first (receipts, adjustments, transfers, sales …) with what came in or went out, the balance
 * after it, the unit cost (for who sees prices) and remarks, in one warehouse or all of them.
 */
export function ItemActivityPage({ itemId }: { itemId: string }) {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('inventory.stock.read')) {
    return <NoAccess title="inventory.nav.title" />;
  }
  return <ItemActivity itemId={itemId} organizationId={session.activeOrganizationId} />;
}

function ItemActivity({
  itemId,
  organizationId,
}: {
  itemId: string;
  organizationId: string | null;
}) {
  const t = useT();
  const { store } = useAuth();
  const [items, reloadItems] = useResource(organizationId, () => loadStockItems(store, true));
  const [warehouses] = useResource(organizationId, () => loadWarehouses(store, true));
  return (
    <Loaded resource={items} reload={reloadItems}>
      {(list) => {
        const item = list.find((i) => i.id === itemId);
        if (!item) {
          return (
            <div className="flex flex-col items-start gap-3">
              <p className="text-muted-foreground">{t('inventory.activity.notFound')}</p>
              <Button variant="outline" asChild>
                <Link href="/inventory">{t('inventory.overview.backToInventory')}</Link>
              </Button>
            </div>
          );
        }
        return (
          <Loaded resource={warehouses} reload={() => undefined}>
            {(warehouseList) => (
              <Activity
                item={item}
                warehouses={warehouseList.filter((w) => !w.isTransit)}
                onChanged={reloadItems}
              />
            )}
          </Loaded>
        );
      }}
    </Loaded>
  );
}

function Activity({
  item,
  warehouses,
  onChanged,
}: {
  item: StockItem;
  warehouses: Warehouse[];
  onChanged: () => void;
}) {
  const t = useT();
  const { store, session } = useAuth();
  const [warehouseId, setWarehouseId] = useState('');
  const [version, setVersion] = useState(0);
  const [movements, reload] = useResource(`${item.id}:${warehouseId}:${version}`, () =>
    loadItemMovements(store, item.id, warehouseId ? { warehouseId } : {}),
  );
  const [levels] = useResource(`levels:${item.id}:${version}`, () => loadStock(store, {}));
  const [categories] = useResource(item.categoryId ? 'activity-categories' : null, () =>
    loadStockCategories(store, true),
  );
  const category =
    categories.status === 'ready'
      ? categories.data.find((c) => c.id === item.categoryId)?.name
      : undefined;
  const canEdit = session?.activePermissions.includes('inventory.items.edit') ?? false;
  const unit = t(`inventory.units.${item.unit}`);
  const held =
    levels.status === 'ready'
      ? levels.data
          .filter((l) => l.itemId === item.id)
          .map((l) => ({ warehouseId: l.warehouseId, quantity: l.quantity }))
      : undefined;
  const head =
    'px-4 py-3 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase';

  return (
    <div className="flex flex-col gap-5" data-testid="item-activity">
      <Card className="flex flex-wrap items-center gap-4 p-4 print:shadow-none">
        <Button
          variant="outline"
          size="icon"
          className="rounded-full print:hidden"
          asChild
          aria-label={t('inventory.overview.backToInventory')}
        >
          <Link href="/inventory">
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <span
          aria-hidden
          className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-muted text-2xl font-semibold text-muted-foreground"
        >
          {item.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="truncate text-2xl font-semibold" data-testid="item-activity-name">
            {item.name}
          </h1>
          <div className="flex flex-wrap gap-2 text-xs font-semibold uppercase">
            <Badge
              className={cn(
                item.archivedAt === null
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {t(item.archivedAt === null ? 'inventory.page.active' : 'inventory.page.archived')}
            </Badge>
            {category && <Badge className="bg-muted text-foreground">{category}</Badge>}
            {item.sku && <Badge className="bg-muted text-foreground">{item.sku}</Badge>}
            <Badge className="bg-muted text-foreground">{unit}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Select
            aria-label={t('inventory.fields.warehouse')}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="min-w-48"
            data-testid="item-activity-warehouse"
          >
            <option value="">{t('inventory.page.allWarehouses')}</option>
            {warehouses
              .filter((w) => w.archivedAt === null)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </Select>
          {canEdit && held && (
            <ItemDialog
              item={item}
              categories={categories.status === 'ready' ? categories.data : null}
              warehouses={warehouses}
              held={held}
              onDone={() => {
                onChanged();
                setVersion((v) => v + 1);
              }}
            />
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={() => window.print()}
            aria-label={t('inventory.activity.print')}
          >
            <Printer aria-hidden />
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <Loaded resource={movements} reload={reload}>
          {(ledger) => {
            const costs = ledger.movements.some((m) => m.unitCost !== null);
            return (
              <>
                <div className="flex flex-wrap items-end justify-between gap-2 border-b p-4">
                  <div className="flex flex-col gap-0.5">
                    <h2 className="text-lg font-semibold">{t('inventory.activity.title')}</h2>
                    <p
                      className="text-sm text-muted-foreground"
                      data-testid="item-activity-summary"
                    >
                      {t('inventory.activity.summary', {
                        opening: shortQuantity(ledger.opening),
                        closing: shortQuantity(ledger.closing),
                        unit,
                      })}
                    </p>
                  </div>
                  <Badge className="bg-muted text-xs font-semibold text-foreground uppercase">
                    {t('inventory.activity.count', { count: String(ledger.movements.length) })}
                  </Badge>
                </div>
                {ledger.movements.length === 0 ? (
                  <p className="p-6 text-center text-muted-foreground">
                    {t('inventory.activity.empty')}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[56rem] text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className={head}>{t('inventory.activity.date')}</th>
                          <th className={head}>{t('inventory.activity.type')}</th>
                          <th className={head}>{t('inventory.activity.number')}</th>
                          <th className={head}>{t('inventory.fields.warehouse')}</th>
                          <th className={`${head} text-right`}>{t('inventory.activity.in')}</th>
                          <th className={`${head} text-right`}>{t('inventory.activity.out')}</th>
                          <th className={`${head} text-right`}>
                            {t('inventory.activity.balance')}
                          </th>
                          {costs && (
                            <th className={`${head} text-right`}>
                              {t('inventory.fields.unitCost')}
                            </th>
                          )}
                          <th className={head}>{t('inventory.activity.remarks')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {ledger.movements.map((m) => (
                          <Row key={m.id} movement={m} costs={costs} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {ledger.truncated && (
                  <p className="border-t p-3 text-right text-xs text-muted-foreground">
                    {t('inventory.activity.truncated', {
                      count: String(ledger.movements.length),
                    })}
                  </p>
                )}
              </>
            );
          }}
        </Loaded>
      </Card>
    </div>
  );
}

function Row({ movement: m, costs }: { movement: ItemMovement; costs: boolean }) {
  const t = useT();
  const incoming = !m.quantity.startsWith('-');
  const amount = shortQuantity(m.quantity.replace('-', ''));
  const type =
    m.kind === 'adjustment' && m.reason
      ? t(`inventory.reasons.${m.reason}`)
      : m.kind === 'transfer'
        ? t(incoming ? 'inventory.activity.transferIn' : 'inventory.activity.transferOut')
        : t(`inventory.kinds.${m.kind}`);
  return (
    <tr data-testid="item-activity-row">
      <td className="px-4 py-3 whitespace-nowrap">
        {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(m.createdAt))}
      </td>
      <td className="px-4 py-3">
        <span
          className={cn(
            'inline-flex rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide uppercase',
            incoming ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive',
          )}
          data-testid="item-activity-type"
        >
          {type}
        </span>
      </td>
      <td className="px-4 py-3 text-muted-foreground">{m.documentNumber}</td>
      <td className="px-4 py-3 text-muted-foreground">{m.warehouseName}</td>
      <td className="px-4 py-3 text-right tabular-nums text-primary" data-testid="item-activity-in">
        {incoming ? amount : ''}
      </td>
      <td
        className="px-4 py-3 text-right tabular-nums text-destructive"
        data-testid="item-activity-out"
      >
        {incoming ? '' : amount}
      </td>
      <td
        className="px-4 py-3 text-right font-medium tabular-nums"
        data-testid="item-activity-balance"
      >
        {shortQuantity(m.balance)}
      </td>
      {costs && (
        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
          {m.unitCost === null ? '—' : m.unitCost.replace(/(\.\d\d\d*?)0+$/, '$1')}
        </td>
      )}
      <td className="px-4 py-3 text-muted-foreground">{m.remarks ?? '—'}</td>
    </tr>
  );
}
