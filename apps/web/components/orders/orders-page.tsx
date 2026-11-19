'use client';

import { SALES_ORDER_STATUSES, type SalesOrderStatus, type SalesOrderSummary } from '@durby/shared';
import { Package, Search, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadStockItems, loadWarehouses } from '../../lib/inventory/api';
import { loadCustomers, loadOrders, type OrderFilter } from '../../lib/orders/api';
import { dayRange, matchesOrder } from '../../lib/orders/form';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { MoneyProvider, useMoney } from '../pos/money';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { OrderDetail, StatusBadge } from './order-detail';
import { OrderDialog, type OrderFormData } from './order-dialog';

/**
 * /orders, Order History (docs/modules/orders.md → Web, ADR 0044): every sales order the user can read, newest first,
 * with status, branch and date filters (sent to the api) and a search over the loaded orders. A row opens the order.
 */
export function OrdersPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('orders.orders.read')) return <NoAccess title="platform.nav.salesOrders" />;
  return (
    <MoneyProvider>
      <Orders
        organizationId={session.activeOrganizationId}
        canCreate={permissions.has('orders.orders.create')}
        canEdit={permissions.has('orders.orders.edit')}
        canCancel={permissions.has('orders.orders.delete')}
        canReadCustomers={permissions.has('orders.customers.read')}
        canAddCustomer={permissions.has('orders.customers.create')}
      />
    </MoneyProvider>
  );
}

interface Page {
  orders: SalesOrderSummary[];
  nextCursor: string | null;
}

function Orders({
  organizationId,
  canCreate,
  canEdit,
  canCancel,
  canReadCustomers,
  canAddCustomer,
}: {
  organizationId: string | null;
  canCreate: boolean;
  canEdit: boolean;
  /** `orders.orders.delete` (ADR 0051). */
  canCancel: boolean;
  canReadCustomers: boolean;
  canAddCustomer: boolean;
}) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const id = useId();
  const [status, setStatus] = useState<SalesOrderStatus | ''>('');
  const [locationId, setLocationId] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [search, setSearch] = useState('');
  const [more, setMore] = useState<Page[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreProblem, setMoreProblem] = useState<string | null>(null);
  // A search result or a link opens one in the side panel (?open=<id>, ADR 0046); a new link opens again.
  const urlOpen = useSearchParams().get('open');
  const [openId, setOpenId] = useState<string | null>(urlOpen);
  const [seenUrl, setSeenUrl] = useState(urlOpen);
  if (urlOpen !== seenUrl) {
    setSeenUrl(urlOpen);
    if (urlOpen) setOpenId(urlOpen);
  }

  const filter: OrderFilter = {
    ...(status ? { status } : {}),
    ...(locationId ? { locationId } : {}),
    ...dayRange(fromDay, toDay),
  };
  const filterKey = JSON.stringify(filter);
  const key = organizationId === null ? null : `${organizationId}:${filterKey}`;
  const [first, reloadFirst] = useResource(key, () => loadOrders(store, filter));
  const [locations] = useResource(organizationId, () => loadLocations(store));
  // What the order form needs; loaded only for people who can create or edit orders.
  const needsForm = organizationId !== null && (canCreate || canEdit);
  const [customers, reloadCustomers] = useResource(
    needsForm && canReadCustomers ? organizationId : null,
    () => loadCustomers(store),
  );
  const [warehouses] = useResource(needsForm ? organizationId : null, () => loadWarehouses(store));
  const [items] = useResource(needsForm ? organizationId : null, () => loadStockItems(store));

  const locationName = (lid: string) =>
    (locations.status === 'ready' ? locations.data.find((l) => l.id === lid)?.name : null) ?? '';
  const formData: OrderFormData | null =
    warehouses.status === 'ready' && items.status === 'ready'
      ? {
          customers: customers.status === 'ready' ? customers.data : [],
          warehouses: warehouses.data,
          items: items.data,
          locationName,
          canAddCustomer,
          reloadCustomers,
        }
      : null;

  const reload = () => {
    setMore([]);
    setMoreProblem(null);
    reloadFirst();
  };
  const changeFilter = (apply: () => void) => {
    apply();
    setMore([]);
    setMoreProblem(null);
  };
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    [],
  );
  const formatTime = (iso: string) => time.format(new Date(iso));
  const filtered = status !== '' || locationId !== '' || fromDay !== '' || toDay !== '';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.nav.salesOrders')}</h1>
          <p className="text-muted-foreground">{t('orders.page.intro')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReadCustomers && (
            <Button variant="outline" asChild>
              <Link href="/orders/customers" data-testid="orders-customers">
                <UsersRound aria-hidden />
                {t('orders.page.customers')}
              </Link>
            </Button>
          )}
          {canCreate && formData && <OrderDialog data={formData} onDone={reload} />}
        </div>
      </div>

      <Card className="flex flex-col gap-0 p-0">
        <div className="grid gap-3 border-b p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto] lg:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-search`}>{t('orders.page.search')}</Label>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={`${id}-search`}
                type="search"
                className="pl-9"
                value={search}
                placeholder={t('orders.page.searchPlaceholder')}
                onChange={(e) => setSearch(e.target.value.slice(0, 100))}
                data-testid="orders-search"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-status`}>{t('orders.page.status')}</Label>
            <Select
              id={`${id}-status`}
              value={status}
              onChange={(e) => changeFilter(() => setStatus(e.target.value as SalesOrderStatus))}
              data-testid="orders-status"
            >
              <option value="">{t('orders.page.allStatuses')}</option>
              {SALES_ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`orders.status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-branch`}>{t('orders.page.branch')}</Label>
            <Select
              id={`${id}-branch`}
              value={locationId}
              onChange={(e) => changeFilter(() => setLocationId(e.target.value))}
              data-testid="orders-branch"
            >
              <option value="">{t('orders.page.allBranches')}</option>
              {locations.status === 'ready' &&
                locations.data.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-from`}>{t('orders.page.from')}</Label>
            <Input
              id={`${id}-from`}
              type="date"
              value={fromDay}
              onChange={(e) => changeFilter(() => setFromDay(e.target.value))}
              data-testid="orders-from"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-to`}>{t('orders.page.to')}</Label>
            <Input
              id={`${id}-to`}
              type="date"
              value={toDay}
              onChange={(e) => changeFilter(() => setToDay(e.target.value))}
              data-testid="orders-to"
            />
          </div>
          {(filtered || search !== '') && (
            <Button
              variant="ghost"
              onClick={() =>
                changeFilter(() => {
                  setStatus('');
                  setLocationId('');
                  setFromDay('');
                  setToDay('');
                  setSearch('');
                })
              }
              data-testid="orders-clear"
            >
              {t('orders.page.clear')}
            </Button>
          )}
        </div>

        <Loaded resource={first} reload={reload}>
          {(page) => {
            const pages: Page[] = [
              { orders: page.data, nextCursor: page.meta.nextCursor },
              ...more,
            ];
            const loaded = pages.flatMap((p) => p.orders);
            const nextCursor = pages[pages.length - 1]?.nextCursor ?? null;
            const shown = loaded.filter((o) => matchesOrder(o, search));
            const loadMore = async () => {
              if (!nextCursor) return;
              setLoadingMore(true);
              setMoreProblem(null);
              const result = await loadOrders(store, filter, nextCursor);
              setLoadingMore(false);
              if (result.ok) {
                setMore((current) => [
                  ...current,
                  { orders: result.data.data, nextCursor: result.data.meta.nextCursor },
                ]);
              } else {
                setMoreProblem(t(errorLabel(result.code)));
              }
            };
            if (shown.length === 0) {
              return (
                <div
                  className="flex flex-col items-center gap-2 px-6 py-12 text-center"
                  data-testid="orders-empty"
                >
                  <Package aria-hidden className="size-8 text-muted-foreground" />
                  <p className="text-muted-foreground">
                    {t(
                      loaded.length === 0 && !filtered
                        ? 'orders.page.empty'
                        : 'orders.page.emptyFiltered',
                    )}
                  </p>
                </div>
              );
            }
            return (
              <div className="flex flex-col">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[44rem] text-sm" data-testid="orders-table">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground uppercase">
                        <th className="px-4 py-2 font-medium">{t('orders.col.number')}</th>
                        <th className="px-4 py-2 font-medium">{t('orders.col.date')}</th>
                        <th className="px-4 py-2 font-medium">{t('orders.col.customer')}</th>
                        <th className="px-4 py-2 font-medium">{t('orders.col.branch')}</th>
                        <th className="px-4 py-2 text-right font-medium">
                          {t('orders.col.items')}
                        </th>
                        <th className="px-4 py-2 text-right font-medium">
                          {t('orders.col.total')}
                        </th>
                        <th className="px-4 py-2 font-medium">{t('orders.col.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((order) => (
                        <tr
                          key={order.id}
                          className="border-b last:border-0 hover:bg-muted/50"
                          data-testid="order-row"
                        >
                          <td className="px-4 py-2">
                            <button
                              type="button"
                              className="min-h-11 font-medium text-primary underline-offset-2 hover:underline"
                              aria-label={t('orders.page.open', { number: order.number })}
                              onClick={() => setOpenId(order.id)}
                              data-testid="order-open"
                            >
                              {order.number}
                            </button>
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                            {formatTime(order.createdAt)}
                          </td>
                          <td className="px-4 py-2">{order.customerName}</td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {`${order.locationName} · ${order.warehouseName}`}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{order.lineCount}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {money(order.total)}
                          </td>
                          <td className="px-4 py-2">
                            <StatusBadge status={order.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-col items-center gap-2 border-t p-4">
                  {search !== '' && nextCursor && (
                    <p className="text-sm text-muted-foreground">{t('orders.page.searchLoaded')}</p>
                  )}
                  <Notice text={moreProblem} tone="error" />
                  {nextCursor && (
                    <Button
                      variant="outline"
                      disabled={loadingMore}
                      onClick={() => void loadMore()}
                      data-testid="orders-more"
                    >
                      {t('orders.page.loadMore')}
                    </Button>
                  )}
                </div>
              </div>
            );
          }}
        </Loaded>
      </Card>

      <OrderDetail
        orderId={openId}
        onClose={() => setOpenId(null)}
        onChanged={reload}
        canEdit={canEdit}
        canCancel={canCancel}
        formData={formData}
        formatTime={formatTime}
      />
    </div>
  );
}
