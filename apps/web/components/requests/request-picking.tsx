'use client';

import {
  type RequestAvailability,
  type StockRequest,
  type StockUnit,
  pickedQuantitySchema,
} from '@durby/shared';
import { Check, ChevronLeft, Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import {
  categoriesOf,
  OTHER_CATEGORY,
  shownItems,
  validQuantity,
} from '../../lib/orders/request-cart';
import { loadAvailability, loadRequest, packRequest } from '../../lib/orders/requests-api';
import { pickPlan, shownStock } from '../../lib/orders/shortage';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Loaded } from '../users/common';
import { RequestStatusBadge } from './common';
import { DriverSelect } from './transfers-picking';

/** The "All items" choice of the add-items dialog; category ids are uuids, so it can't clash. */
const ALL = '*';

const isZero = (quantity: string) => /^0(\.0+)?$/.test(quantity);
/** What a typed quantity means to the api: a comma as the decimal point, blank as nothing. */
const normal = (quantity: string) => quantity.trim().replace(',', '.') || '0';
/** Two quantities added, to three decimals. */
const plus = (a: string, b: string) =>
  (Math.round((Number(a) + Number(b)) * 1000) / 1000).toString();

interface Extra {
  itemId: string;
  name: string;
  unit: StockUnit;
}

/** What the add-items dialog holds until "Add to shipment". */
type Cart = Record<string, { name: string; unit: StockUnit; quantity: string }>;

/**
 * One transfer being picked and packed (ADR 0045, item 9): each line with what was requested, what came off the
 * shelf (may be more than requested), and a packed tick; products nobody asked for are added from their category.
 */
export function RequestPicking({ requestId }: { requestId: string }) {
  const { store } = useAuth();
  const [detail, reload] = useResource(requestId, () => loadRequest(store, requestId));
  return (
    <Loaded resource={detail} reload={reload}>
      {(request) => <PickBoard request={request} />}
    </Loaded>
  );
}

function PickBoard({ request }: { request: StockRequest }) {
  const { store } = useAuth();
  const [availability, reloadAvailability] = useResource(`${request.fromWarehouseId}:pick`, () =>
    loadAvailability(store, request.fromWarehouseId),
  );
  return (
    <Loaded resource={availability} reload={reloadAvailability}>
      {(items) => <Board request={request} items={items} />}
    </Loaded>
  );
}

function Board({
  request,
  items,
}: {
  request: StockRequest;
  items: readonly RequestAvailability[];
}) {
  const t = useT();
  const { store, session } = useAuth();
  const action = useActionKey();
  const router = useRouter();
  const canAssign = session?.activePermissions.includes('orders.delivery.assign') ?? false;
  const editable = request.status === 'approved' || request.status === 'picking';
  const shelf = useMemo(() => new Map(items.map((i) => [i.itemId, i])), [items]);
  // The lines the warehouse sends: approved and more than none.
  const asked = request.lines.filter(
    (l) => l.approvedQuantity !== null && !isZero(l.approvedQuantity),
  );
  // Picked starts at what was asked, or what is on the shelf when that is less (the rest is shown as short).
  const [picked, setPicked] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      asked.map((l) => [
        l.id,
        l.pickedQuantity ??
          pickPlan(l.approvedQuantity!, shelf.get(l.itemId)?.available ?? '0').initial,
      ]),
    ),
  );
  // Ticked off as they go in the box: kept on this screen only.
  const [packed, setPacked] = useState<Record<string, boolean>>({});
  const [extras, setExtras] = useState<Extra[]>([]);
  const [group, setGroup] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [driver, setDriver] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rows = [
    ...asked.map((l) => {
      const s = shelf.get(l.itemId);
      return {
        key: l.id,
        itemId: l.itemId,
        name: l.itemName,
        unit: l.unit,
        requested: l.approvedQuantity,
        onShelf: s?.available ?? '0',
        categoryId: s?.categoryId ?? null,
        categoryName: s?.categoryName ?? null,
        extra: false,
      };
    }),
    ...extras.map((e) => {
      const s = shelf.get(e.itemId);
      return {
        key: `x:${e.itemId}`,
        itemId: e.itemId,
        name: e.name,
        unit: e.unit,
        requested: null,
        onShelf: s?.available ?? '0',
        categoryId: s?.categoryId ?? null,
        categoryName: s?.categoryName ?? null,
        extra: true,
      };
    }),
  ];
  const packedCount = rows.filter((r) => packed[r.key]).length;
  const chips = [
    ...rows
      .reduce((m, r) => {
        const id = r.categoryId ?? OTHER_CATEGORY;
        const entry = m.get(id) ?? { id, name: r.categoryName, count: 0 };
        entry.count += 1;
        m.set(id, entry);
        return m;
      }, new Map<string, { id: string; name: string | null; count: number }>())
      .values(),
  ].sort(
    (a, b) =>
      Number(a.name === null) - Number(b.name === null) ||
      (a.name ?? '').localeCompare(b.name ?? ''),
  );
  const shown = rows
    .filter((r) => group === null || (r.categoryId ?? OTHER_CATEGORY) === group)
    .sort(
      (a, b) =>
        Number(a.categoryName === null) - Number(b.categoryName === null) ||
        (a.categoryName ?? '').localeCompare(b.categoryName ?? ''),
    );

  function addToShipment(cart: Cart) {
    setPicked((prev) => {
      const next = { ...prev };
      for (const [itemId, c] of Object.entries(cart)) {
        const line = asked.find((l) => l.itemId === itemId);
        const key = line ? line.id : `x:${itemId}`;
        next[key] = plus(next[key] ?? '0', c.quantity);
      }
      return next;
    });
    setExtras((prev) => [
      ...prev,
      ...Object.entries(cart)
        .filter(
          ([itemId]) =>
            !asked.some((l) => l.itemId === itemId) && !prev.some((e) => e.itemId === itemId),
        )
        .map(([itemId, c]) => ({ itemId, name: c.name, unit: c.unit })),
    ]);
  }

  function removeExtra(itemId: string) {
    const key = `x:${itemId}`;
    setExtras((prev) => prev.filter((e) => e.itemId !== itemId));
    setPicked((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setPacked((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function pack() {
    setError(null);
    const lines = asked.map((l) => ({ lineId: l.id, quantity: normal(picked[l.id] ?? '0') }));
    const extra = extras.map((e) => ({
      itemId: e.itemId,
      quantity: normal(picked[`x:${e.itemId}`] ?? '0'),
    }));
    const bad =
      [...lines, ...extra].some((l) => !pickedQuantitySchema.safeParse(l.quantity).success) ||
      extra.some((e) => !validQuantity(e.quantity));
    if (bad) {
      setError(t('orders.pick.invalid'));
      return;
    }
    const result = await packRequest(store, action, request.id, {
      lines,
      ...(extra.length > 0 ? { extra } : {}),
      ...(driver ? { driverUserId: driver } : {}),
    });
    if (result.ok) router.push('/picking');
    else setError(t(errorLabel(result.code)));
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="pick-title">
      <Link
        href="/picking"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft aria-hidden className="size-4" />
        {t('orders.pick.back')}
      </Link>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="pick-title" className="text-2xl font-semibold">
            {request.transferNumber ?? request.number}
          </h1>
          <RequestStatusBadge status={request.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t('orders.requestsPage.route', {
            from: request.fromWarehouseName,
            // Without a branch store (ADR 0080) just the branch.
            to: [request.locationName, request.toWarehouseName].filter(Boolean).join(' · '),
          })}
        </p>
      </div>
      {!editable && (
        <p className="text-sm text-muted-foreground" data-testid="pick-not-editable">
          {t('orders.pick.notEditable')}
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm" data-testid="pick-progress">
          {t('orders.pick.progress', { packed: String(packedCount), total: String(rows.length) })}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {canAssign && editable && (
            <DriverSelect
              warehouseId={request.fromWarehouseId}
              value={driver}
              onChange={setDriver}
              allowNone
            />
          )}
          <Button
            type="button"
            onClick={() => void pack()}
            disabled={!editable || rows.length === 0}
            data-testid="pick-submit"
          >
            {t('orders.pick.markPacked')}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div role="tablist" className="flex flex-wrap gap-2">
        <Chip
          active={group === null}
          onClick={() => setGroup(null)}
          label={t('orders.pick.allItems')}
          count={rows.length}
          testId="pick-group-all"
        />
        {chips.map((c) => (
          <Chip
            key={c.id}
            active={group === c.id}
            onClick={() => setGroup(c.id)}
            label={c.name ?? t('orders.pick.noCategory')}
            count={c.count}
            testId="pick-group"
          />
        ))}
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-x-3 px-4 text-xs font-medium text-muted-foreground uppercase sm:grid-cols-[1fr_6rem_6rem_9rem]">
        <span>{t('orders.requestsPage.items', { count: String(shown.length) })}</span>
        <span className="hidden text-right sm:block">{t('orders.pick.requested')}</span>
        <span className="hidden text-right sm:block">{t('orders.pick.picked')}</span>
        <span className="hidden text-center sm:block">{t('orders.pick.packed')}</span>
      </div>
      <ul className="flex flex-col divide-y rounded-lg border" data-testid="pick-list">
        {shown.map((r, index) => {
          const isPacked = packed[r.key] === true;
          const newGroup = index === 0 || shown[index - 1]!.categoryId !== r.categoryId;
          return (
            <li key={r.key} className="flex flex-col">
              {newGroup && (
                <span className="bg-muted/50 px-4 py-1.5 text-xs font-semibold uppercase">
                  {r.categoryName ?? t('orders.pick.noCategory')}
                </span>
              )}
              <div
                className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[1fr_6rem_6rem_9rem]"
                data-testid="pick-row"
                data-extra={r.extra ? 'true' : 'false'}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {r.name}
                    {r.extra && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal">
                        {t('orders.pick.extra')}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('orders.pick.onShelf', {
                      quantity: `${shownStock(r.onShelf)} ${t(`inventory.units.${r.unit}`)}`,
                    })}
                  </span>
                </span>
                <span
                  className="hidden text-right tabular-nums sm:block"
                  data-testid="pick-requested"
                >
                  {r.requested === null ? '–' : `${r.requested} ${t(`inventory.units.${r.unit}`)}`}
                </span>
                <Input
                  inputMode="decimal"
                  className="w-24 justify-self-end text-right tabular-nums"
                  aria-label={`${t('orders.pick.picked')}: ${r.name}`}
                  value={picked[r.key] ?? '0'}
                  disabled={!editable}
                  onChange={(e) =>
                    setPicked((prev) => ({ ...prev, [r.key]: e.target.value.replace(',', '.') }))
                  }
                  data-testid="pick-quantity"
                />
                <div className="flex items-center justify-end gap-2 sm:justify-center">
                  <Button
                    type="button"
                    variant={isPacked ? 'default' : 'outline'}
                    aria-pressed={isPacked}
                    disabled={!editable}
                    onClick={() => setPacked((prev) => ({ ...prev, [r.key]: !isPacked }))}
                    data-testid="pick-packed"
                  >
                    {isPacked ? (
                      <>
                        <Check aria-hidden className="size-4" />
                        {t('orders.pick.packed')}
                      </>
                    ) : (
                      t('orders.pick.markPacked')
                    )}
                  </Button>
                  {r.extra && editable && (
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={t('orders.pick.remove', { name: r.name })}
                      onClick={() => removeExtra(r.itemId)}
                      data-testid="pick-extra-remove"
                    >
                      <X aria-hidden className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Button
        type="button"
        variant="outline"
        className="w-full border-dashed"
        disabled={!editable}
        onClick={() => setAdding(true)}
        data-testid="pick-add-item"
      >
        <Plus aria-hidden className="size-4" />
        {t('orders.pick.addItem')}
      </Button>

      <AddItemsDialog open={adding} onOpenChange={setAdding} items={items} onAdd={addToShipment} />
    </section>
  );
}

function Chip({
  active,
  onClick,
  label,
  count,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm',
        active ? 'border-primary bg-primary/10 font-medium' : 'border-input',
      )}
    >
      {label}
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

/**
 * "Add items to the shipment": a category, then each item with what is on the shelf, how many go in, and Add. What
 * is added is picked into the shipment when "Add to shipment" is pressed; nothing is booked until packing.
 */
function AddItemsDialog({
  open,
  onOpenChange,
  items,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly RequestAvailability[];
  onAdd: (cart: Cart) => void;
}) {
  const t = useT();
  const [group, setGroup] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<Cart>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const groups = useMemo(() => categoriesOf(items), [items]);
  const shown = shownItems(items, group === null || group === ALL ? null : group, search);
  const count = Object.keys(cart).length;

  function close() {
    setGroup(null);
    setSearch('');
    setCart({});
    setDrafts({});
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        closeLabel={t('platform.common.close')}
        className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
      >
        <DialogTitle>{t('orders.pick.addTitle')}</DialogTitle>
        <p className="text-sm text-muted-foreground">{t('orders.pick.addHint')}</p>
        {group === null ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => setGroup(ALL)}
              data-testid="pick-category"
              className="flex flex-col items-start gap-1 rounded-lg border p-3 text-left"
            >
              <span className="font-medium">{t('orders.pick.allItems')}</span>
              <span className="text-xs text-muted-foreground">
                {t('orders.requestsPage.items', { count: String(items.length) })}
              </span>
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setGroup(g.id)}
                data-testid="pick-category"
                className="flex flex-col items-start gap-1 rounded-lg border p-3 text-left"
              >
                <span className="font-medium">{g.name ?? t('orders.pick.noCategory')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('orders.requestsPage.items', { count: String(g.count) })}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setGroup(null)}
                data-testid="pick-categories"
              >
                <ChevronLeft aria-hidden className="size-4" />
                {t('orders.pick.categories')}
              </Button>
              <div className="relative min-w-48 flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  className="pl-9"
                  aria-label={t('orders.pick.search')}
                  placeholder={t('orders.pick.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="pick-search"
                />
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('orders.pick.noItems')}</p>
            ) : (
              <ul className="divide-y" data-testid="pick-add-list">
                {shown.map((i) => {
                  const inCart = cart[i.itemId];
                  const unit = t(`inventory.units.${i.unit}`);
                  return (
                    <li
                      key={i.itemId}
                      className="flex flex-wrap items-center gap-3 py-2"
                      data-testid="pick-add-row"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium">{i.itemName}</span>
                        <span className="text-xs text-muted-foreground">
                          {[
                            i.sku,
                            t('orders.pick.onShelf', {
                              quantity: `${shownStock(i.available)} ${unit}`,
                            }),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      {inCart && (
                        <span className="text-xs" data-testid="pick-in-shipment">
                          {t('orders.pick.inShipment', { quantity: `${inCart.quantity} ${unit}` })}
                        </span>
                      )}
                      <Input
                        inputMode="decimal"
                        className="w-24 text-right tabular-nums"
                        aria-label={`${i.itemName} (${unit})`}
                        value={drafts[i.itemId] ?? ''}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [i.itemId]: e.target.value.replace(',', '.'),
                          }))
                        }
                        data-testid="pick-add-quantity"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          const quantity = normal(drafts[i.itemId] ?? '');
                          if (!validQuantity(quantity)) return;
                          setCart((prev) => ({
                            ...prev,
                            [i.itemId]: { name: i.itemName, unit: i.unit, quantity },
                          }));
                          setDrafts((prev) => ({ ...prev, [i.itemId]: '' }));
                        }}
                        data-testid="pick-add-line"
                      >
                        <Plus aria-hidden className="size-4" />
                        {t('orders.pick.addLine')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <span className="text-sm" data-testid="pick-cart-count">
            {t('orders.pick.pickedCount', { count: String(count) })}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={close}>
              {t('orders.pick.cancel')}
            </Button>
            <Button
              type="button"
              disabled={count === 0}
              onClick={() => {
                onAdd(cart);
                close();
              }}
              data-testid="pick-add-submit"
            >
              {t('orders.pick.addToShipment')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
