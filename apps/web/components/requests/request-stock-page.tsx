'use client';

import {
  type RequestAvailability,
  type RequestDestination,
  type RequestWarehouse,
  STOCK_REQUEST_NOTE_MAX_LENGTH,
} from '@durby/shared';
import { CheckCircle2, Package, Search, ShoppingBasket, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useId, useMemo, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { categoryColor } from '../../lib/catalog/category-image';
import {
  availableText,
  beyondStock,
  type Cart,
  cartLines,
  cartReady,
  cartStorageKey,
  type CartUnits,
  categoriesOf,
  OTHER_CATEGORY,
  parseStoredCart,
  remove,
  requestLines,
  shownItems,
  unitsStorageKey,
} from '../../lib/orders/request-cart';
import {
  createRequest,
  loadAvailability,
  loadRequestDestinations,
  loadRequestWarehouses,
} from '../../lib/orders/requests-api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { useNavLayout } from '../theme-provider';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet';
import { Loaded, NoAccess } from '../users/common';
import { AvailableText, CartControl, useCartUnits } from './cart-controls';

/**
 * /requests/new, Request stock (docs/modules/orders.md → Branch requests, ADR 0045, 0053): a branch fills a cart like
 * a shopping basket (categories, search, + and −) from the main warehouse's items with what it has, then sends it as
 * one request. Quantities only, never prices. Needs `orders.requests.create` at the branch.
 */
/** `inSheet`: opened from Inventory's cart (ADR 0065): the person stays there, so no link leads to Order History. */
export function RequestStockPage({ inSheet = false }: { inSheet?: boolean } = {}) {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('orders.requests.create'))
    return <NoAccess title="platform.nav.requestStock" />;
  // Branches send requests; those who approve them do that in Order History.
  if (session.activePermissions.includes('orders.requests.approve')) {
    return <BranchOnly />;
  }
  return <RequestStock organizationId={session.activeOrganizationId} inSheet={inSheet} />;
}

/** For those who approve requests: branches send them; approving happens in Order History. */
function BranchOnly() {
  const t = useT();
  return (
    <div className="flex max-w-3xl flex-col gap-3" data-testid="request-branch-only">
      <h1 className="text-2xl font-semibold">{t('platform.nav.requestStock')}</h1>
      <Notice text={t('orders.requestForm.branchOnly')} tone="info" />
      <Button variant="outline" asChild className="self-start">
        <Link href="/requests">{t('platform.nav.orderHistory')}</Link>
      </Button>
    </div>
  );
}

function RequestStock({
  organizationId,
  inSheet,
}: {
  organizationId: string | null;
  inSheet: boolean;
}) {
  const t = useT();
  const { store, session } = useAuth();
  // A branch calls its requests Order History (ADR 0059).
  const operations = useNavLayout() === 'operations';
  // Who can give people their branch can also fix an empty list.
  const setsUpStaff = session?.activePermissions.includes('platform.users.edit') ?? false;
  const [warehouses] = useResource(organizationId, () => loadRequestWarehouses(store));
  const [destinations] = useResource(organizationId, () => loadRequestDestinations(store));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex max-w-3xl flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.nav.requestStock')}</h1>
          <p className="text-muted-foreground">{t('orders.requestForm.intro')}</p>
        </div>
        {!inSheet && (
          <Button variant="outline" asChild>
            <Link href="/requests">
              {t(operations ? 'platform.nav.orderHistory' : 'platform.nav.stockRequests')}
            </Link>
          </Button>
        )}
      </div>
      <Loaded resource={warehouses} reload={() => undefined}>
        {(sources) => (
          <Loaded resource={destinations} reload={() => undefined}>
            {(branches) =>
              branches.length === 0 || !organizationId ? (
                setsUpStaff ? (
                  <NoBranchSetup />
                ) : (
                  <Notice text={t('orders.requestForm.noWarehouse')} tone="info" />
                )
              ) : (
                <Shop
                  organizationId={organizationId}
                  sources={sources}
                  branches={branches}
                  inSheet={inSheet}
                />
              )
            }
          </Loaded>
        )}
      </Loaded>
    </div>
  );
}

/**
 * No branch to request for, said to someone who can change it (ADR 0059): requests bring goods from the main warehouse
 * to another branch, so a branch apart from the main warehouse's is needed, and its people need it ticked.
 */
function NoBranchSetup() {
  const t = useT();
  return (
    <Card className="flex max-w-3xl flex-col gap-3 p-4" data-testid="request-no-branch-setup">
      <p>{t('orders.requestForm.noBranchSetup')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild>
          <Link href="/branches">{t('platform.nav.branches')}</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/staff">{t('platform.nav.staff')}</Link>
        </Button>
      </div>
    </Card>
  );
}

function Shop({
  organizationId,
  sources,
  branches,
  inSheet,
}: {
  organizationId: string;
  sources: RequestWarehouse[];
  branches: RequestDestination[];
  inSheet: boolean;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [branchId, setBranchId] = useState(branches[0]!.locationId);
  const branch = branches.find((b) => b.locationId === branchId) ?? branches[0]!;
  // The warehouse supplying this branch (ADR 0067), else the main one (ADR 0053); without either the branch picks.
  const main =
    sources.find((w) => w.id === branch.supplierWarehouseId) ?? sources.find((w) => w.isMain);
  const choices = sources.filter((w) => w.locationId !== branch.locationId);
  const [chosenSource, setChosenSource] = useState('');
  const from =
    main ?? choices.find((w) => w.id === chosenSource) ?? choices.find((w) => !w.isMain) ?? null;
  const [items] = useResource(from ? `${organizationId}:${from.id}` : null, () =>
    loadAvailability(store, from!.id),
  );

  const key = cartStorageKey(organizationId, branch.locationId);
  const [units, setUnit] = useCartUnits(unitsStorageKey(organizationId, branch.locationId));
  const [cart, setCartState] = useState<Cart>(() => readCart(key));
  const [cartKey, setCartKey] = useState(key);
  if (cartKey !== key) {
    setCartKey(key);
    setCartState(readCart(key));
  }
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(cart));
    } catch {
      // Private mode or blocked storage: the cart lives only on this page.
    }
  }, [key, cart]);
  const setCart = (next: Cart) => {
    setCartState(next);
    setSent(null);
  };

  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // From the shop's "View request" (?cart=1): straight to sending the request, not the product list (item 5).
  const [open, setOpen] = useState(useSearchParams().get('cart') === '1');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; number: string } | null>(null);

  const list = items.status === 'ready' ? items.data : [];
  const lines = cartLines(cart, list);
  const count = lines.length;

  async function send() {
    if (!from) return;
    if (!cartReady(lines)) {
      const beyond = beyondStock(lines);
      setError(
        beyond.length > 0
          ? t('orders.requestCart.beyondStock', {
              items: beyond
                .map((l) =>
                  t('orders.requestCart.itemAvailable', {
                    name: l.item.itemName,
                    quantity: availableText(l.item.available),
                    unit: t(`inventory.units.${l.item.unit}`),
                  }),
                )
                .join(', '),
            })
          : t('orders.requestForm.quantityInvalid'),
      );
      return;
    }
    setBusy(true);
    setError(null);
    const result = await createRequest(store, action, {
      ...(main ? {} : { fromWarehouseId: from.id }),
      ...(branch.warehouseId
        ? { toWarehouseId: branch.warehouseId }
        : { toLocationId: branch.locationId }),
      lines: requestLines(lines),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(t(errorLabel(result.ok ? 'unknown' : result.code)));
      return;
    }
    action.done();
    setCartState({});
    setNote('');
    setOpen(false);
    setSent({ id: result.data.id, number: result.data.number });
  }

  return (
    <>
      <Card className="grid gap-3 p-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-from`}>{t('orders.requestForm.from')}</Label>
          {main ? (
            <p
              id={`${id}-from`}
              className="flex min-h-11 items-center gap-2 font-medium"
              data-testid="request-from-main"
            >
              <Package aria-hidden className="size-4 text-primary" />
              {t('orders.requestCart.fromMain', { name: main.name })}
            </p>
          ) : (
            <Select
              id={`${id}-from`}
              value={from?.id ?? ''}
              onChange={(e) => setChosenSource(e.target.value)}
              data-testid="request-from"
            >
              {choices.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.locationName === w.name ? w.name : `${w.name} · ${w.locationName}`}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-to`}>{t('orders.requestForm.to')}</Label>
          {branches.length === 1 ? (
            <p id={`${id}-to`} className="flex min-h-11 items-center font-medium">
              {branch.locationName}
            </p>
          ) : (
            <Select
              id={`${id}-to`}
              value={branch.locationId}
              onChange={(e) => setBranchId(e.target.value)}
              data-testid="request-to"
            >
              {branches.map((b) => (
                <option key={b.locationId} value={b.locationId}>
                  {b.locationName}
                </option>
              ))}
            </Select>
          )}
        </div>
      </Card>

      {sent && (
        <Card
          className="flex flex-wrap items-center justify-between gap-3 border-primary/40 bg-primary/5 p-4"
          role="status"
          data-testid="request-sent"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 aria-hidden className="mt-0.5 size-6 shrink-0 text-primary" />
            <div className="flex flex-col gap-0.5">
              <p className="font-semibold">
                {t('orders.requestCart.sentTitle', { number: sent.number })}
              </p>
              <p className="text-sm text-muted-foreground">{t('orders.requestCart.sentHint')}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link
                href={`/requests/${sent.id}/oc`}
                target="_blank"
                rel="noopener"
                data-testid="request-sent-oc"
              >
                {t('orders.documents.oc')}
              </Link>
            </Button>
            {!inSheet && (
              <Button variant="outline" asChild>
                <Link href={`/requests?open=${sent.id}`}>{t('orders.requestCart.follow')}</Link>
              </Button>
            )}
          </div>
        </Card>
      )}

      {!from ? (
        <Notice text={t('orders.requestCart.noSource')} tone="info" />
      ) : (
        <Loaded resource={items} reload={() => undefined}>
          {(offered) => (
            <Catalogue
              items={offered}
              cart={cart}
              onCart={setCart}
              units={units}
              onUnit={setUnit}
              category={category}
              onCategory={setCategory}
              search={search}
              onSearch={setSearch}
            />
          )}
        </Loaded>
      )}

      {count > 0 && (
        <div className="sticky bottom-3 z-30 rounded-xl border bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 font-medium" data-testid="request-cart-count">
              <ShoppingBasket aria-hidden className="size-5 text-primary" />
              {t('orders.requestCart.bar', { count: String(count) })}
            </span>
            <Button onClick={() => setOpen(true)} data-testid="request-cart-open">
              {t('orders.requestCart.view')}
            </Button>
          </div>
        </div>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          closeLabel={t('platform.common.close')}
          className="flex w-full flex-col gap-4 p-5 sm:max-w-md"
          data-testid="request-cart"
        >
          {/* Clear of the close button in the corner. */}
          <div className="flex flex-col gap-1 pr-10">
            <SheetTitle className="not-sr-only text-xl font-semibold">
              {t('orders.requestCart.title')}
            </SheetTitle>
            <SheetDescription className="not-sr-only text-sm text-muted-foreground">
              {t('orders.requestCart.route', {
                from: from?.name ?? '',
                to: branch.locationName,
              })}
            </SheetDescription>
          </div>
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('orders.requestCart.emptyCart')}</p>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col divide-y overflow-y-auto border-y">
              {lines.map(({ item, quantity }) => (
                <li
                  key={item.itemId}
                  className="flex items-center gap-3 py-3"
                  data-testid="request-cart-line"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{item.itemName}</span>
                    <AvailableText item={item} quantity={quantity} />
                  </div>
                  <CartControl
                    item={item}
                    quantity={quantity}
                    onChange={(next) => setCart(next(cart))}
                    unit={units[item.itemId]}
                    onUnit={(unit) => setUnit(item.itemId, unit)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setCart(remove(cart, item.itemId))}
                    aria-label={t('orders.requestCart.remove', { name: item.itemName })}
                    data-testid="request-cart-remove"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {!branch.warehouseId && lines.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('orders.requestCart.newStore', { branch: branch.locationName })}
            </p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-note`}>{t('orders.requestForm.note')}</Label>
            <textarea
              id={`${id}-note`}
              value={note}
              rows={2}
              maxLength={STOCK_REQUEST_NOTE_MAX_LENGTH}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              data-testid="request-note"
            />
          </div>
          <Notice text={error} tone="error" />
          <div className="mt-auto flex flex-col gap-2">
            <Button
              disabled={busy || lines.length === 0}
              onClick={() => void send()}
              data-testid="request-submit"
            >
              {t('orders.requestCart.send', { count: String(lines.length) })}
            </Button>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('orders.requestCart.continue')}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Catalogue({
  items,
  cart,
  onCart,
  units,
  onUnit,
  category,
  onCategory,
  search,
  onSearch,
}: {
  items: RequestAvailability[];
  cart: Cart;
  onCart: (cart: Cart) => void;
  units: CartUnits;
  onUnit: (itemId: string, unit: 'box' | 'piece') => void;
  category: string | null;
  onCategory: (category: string | null) => void;
  search: string;
  onSearch: (search: string) => void;
}) {
  const t = useT();
  const categories = useMemo(() => categoriesOf(items), [items]);
  const shown = shownItems(items, category, search);
  const chip = (active: boolean) =>
    cn(
      'flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors',
      active ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t('orders.requestForm.search')}
          aria-label={t('orders.requestForm.search')}
          className="pl-9"
          data-testid="request-search"
        />
      </div>
      {categories.length > 1 && (
        <div
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
          role="group"
          aria-label={t('orders.requestCart.categories')}
        >
          <button
            type="button"
            className={chip(category === null)}
            aria-pressed={category === null}
            onClick={() => onCategory(null)}
            data-testid="request-category"
          >
            {t('orders.requestCart.all')}
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={chip(category === c.id)}
              aria-pressed={category === c.id}
              onClick={() => onCategory(c.id)}
              data-testid="request-category"
            >
              {c.id !== OTHER_CATEGORY && (
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ background: categoryColor(c.id) }}
                />
              )}
              {c.name ?? t('orders.requestCart.other')}
              <span className="text-xs opacity-70">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">{t('orders.requestForm.empty')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((item) => (
            <li key={item.itemId}>
              <ItemCard
                item={item}
                quantity={cart[item.itemId]}
                onChange={(next) => onCart(next(cart))}
                unit={units[item.itemId]}
                onUnit={(unit) => onUnit(item.itemId, unit)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ItemCard({
  item,
  quantity,
  onChange,
  unit,
  onUnit,
}: {
  item: RequestAvailability;
  quantity: string | undefined;
  onChange: (next: (cart: Cart) => Cart) => void;
  unit: 'box' | 'piece' | undefined;
  onUnit: (unit: 'box' | 'piece') => void;
}) {
  const t = useT();
  const out = Number(item.available) <= 0;
  const color = item.categoryId ? categoryColor(item.categoryId) : null;
  return (
    <Card
      className={cn(
        'flex h-full flex-col gap-3 p-3',
        quantity !== undefined && 'border-primary ring-1 ring-primary',
      )}
      data-testid="request-item"
      data-item={item.itemId}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-lg font-semibold text-foreground/70"
          style={color ? { background: color } : undefined}
        >
          {item.itemName.slice(0, 1).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="line-clamp-2 font-medium">{item.itemName}</span>
          {item.sku && <span className="text-xs text-muted-foreground">{item.sku}</span>}
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        {out ? (
          <span className="text-sm text-destructive" data-testid="request-item-available">
            {t('orders.requestCart.outOfStock')}
          </span>
        ) : (
          <AvailableText item={item} quantity={quantity} testId="request-item-available" />
        )}
        <CartControl
          item={item}
          quantity={quantity}
          onChange={onChange}
          unit={unit}
          onUnit={onUnit}
        />
      </div>
    </Card>
  );
}

function readCart(key: string): Cart {
  try {
    return parseStoredCart(localStorage.getItem(key));
  } catch {
    return {};
  }
}
