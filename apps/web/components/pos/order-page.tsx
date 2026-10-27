'use client';

import {
  type FloorTable,
  type KitchenTicket,
  type Order,
  ORDER_LINE_MAX_QUANTITY,
  ORDER_NOTE_MAX_LENGTH,
  type Product,
  type ProductCategory,
  type SendTicketResponse,
} from '@durby/shared';
import { ArrowLeft, Clock, Minus, Plus, Search, StickyNote, Users } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories, loadProducts } from '../../lib/catalog/api';
import { loadTableOrder, sendTicket } from '../../lib/pos/api';
import { minutesSince, sum, times } from '../../lib/pos/format';
import { useNow } from '../../lib/pos/use-now';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Loaded, NoAccess } from '../users/common';
import { BillPanel, type OrderAccess } from './bill-panel';
import { KitchenTicketView, PrintRoot } from './kitchen-ticket';
import { MoneyProvider, useMoney } from './money';

/** /pos/order/[tableId]: take a table's order and send it to the kitchen (docs/modules/pos.md). */
export function OrderPage({ tableId }: { tableId: string }) {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('pos.orders.read')) return <NoAccess title="pos.nav.title" />;
  return (
    <MoneyProvider>
      <TableOrder
        tableId={tableId}
        access={{
          canTake: permissions.has('pos.orders.take'),
          canVoid: permissions.has('pos.orders.void'),
          canClose: permissions.has('pos.orders.close'),
        }}
      />
    </MoneyProvider>
  );
}

interface CartLine {
  product: Product;
  quantity: number;
  note: string;
}

/** The ticket to print, with a fresh `at` per request so a reprint prints again. */
interface PrintJob {
  ticket: KitchenTicket;
  orderNumber: string;
  at: number;
}

type Panel = 'cart' | 'bill';

function TableOrder({ tableId, access }: { tableId: string; access: OrderAccess }) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const action = useActionKey();
  const [view, reload] = useResource(tableId, () => loadTableOrder(store, tableId));
  const now = useNow(30_000);
  const [print, setPrint] = useState<PrintJob | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [panel, setPanel] = useState<Panel>(access.canTake ? 'cart' : 'bill');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (print) window.print();
  }, [print]);

  const printTicket = (order: Order, ticketId: string) => {
    const ticket = order.tickets.find((x) => x.id === ticketId);
    if (ticket) setPrint({ ticket, orderNumber: order.number, at: Date.now() });
  };
  const afterWrite = (response: SendTicketResponse) => {
    reload();
    printTicket(response.order, response.ticketId);
  };

  const add = (product: Product) => {
    setSent(null);
    setCart((lines) =>
      lines.some((l) => l.product.id === product.id)
        ? lines.map((l) =>
            l.product.id === product.id
              ? { ...l, quantity: Math.min(l.quantity + 1, ORDER_LINE_MAX_QUANTITY) }
              : l,
          )
        : [...lines, { product, quantity: 1, note: '' }],
    );
  };
  const change = (productId: string, patch: Partial<CartLine>) =>
    setCart((lines) =>
      lines
        .map((l) => (l.product.id === productId ? { ...l, ...patch } : l))
        .filter((l) => l.quantity > 0),
    );

  const cartCount = cart.reduce((n, l) => n + l.quantity, 0);
  const cartTotal = sum(cart.map((l) => times(l.product.price, l.quantity)));

  async function send() {
    if (cart.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await sendTicket(store, action, tableId, {
      lines: cart.map((l) => ({
        productId: l.product.id,
        quantity: l.quantity,
        note: l.note.trim(),
      })),
    });
    setBusy(false);
    if (result.ok && result.data) {
      const ticket = result.data.order.tickets.find((x) => x.id === result.data?.ticketId);
      setCart([]);
      setSent(t('pos.order.sent', { sequence: String(ticket?.sequence ?? '') }));
      setPanel('bill');
      afterWrite(result.data);
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <Loaded resource={view} reload={reload}>
      {({ table, order }) => (
        <div
          className={cn(
            'flex flex-col gap-5',
            access.canTake && cart.length > 0 && 'pb-24 lg:pb-0',
          )}
        >
          <OrderHeader table={table} order={order} now={now} />
          <div
            className={cn('grid items-start gap-6', access.canTake && 'lg:grid-cols-[1fr_26rem]')}
          >
            {access.canTake && <Menu tableId={tableId} cart={cart} onAdd={add} />}
            <Card
              id="order-panel"
              className="flex flex-col gap-3 p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto"
            >
              <Tabs value={panel} onValueChange={(v) => setPanel(v as Panel)}>
                <TabsList className="grid w-full grid-cols-2">
                  {access.canTake && (
                    <TabsTrigger value="cart" data-testid="tab-cart">
                      {t('pos.order.cart')}
                      {cartCount > 0 && <Badge className="ml-2">{cartCount}</Badge>}
                    </TabsTrigger>
                  )}
                  <TabsTrigger
                    value="bill"
                    data-testid="tab-bill"
                    className={cn(!access.canTake && 'col-span-2')}
                  >
                    {t('pos.bill.title')}
                  </TabsTrigger>
                </TabsList>
                {access.canTake && (
                  <TabsContent value="cart" className="flex flex-col gap-3 pt-3">
                    <Cart
                      cart={cart}
                      onChange={change}
                      onClear={() => setCart([])}
                      total={cartTotal}
                    />
                    <Notice text={error} tone="error" />
                    <Button
                      className="min-h-12 text-base"
                      disabled={cart.length === 0 || busy}
                      onClick={() => void send()}
                      data-testid="send-to-kitchen"
                    >
                      {t('pos.order.sendCount', { count: String(cartCount) })} · {money(cartTotal)}
                    </Button>
                  </TabsContent>
                )}
                <TabsContent value="bill" className="flex flex-col gap-3 pt-3">
                  <Notice text={sent} tone="info" />
                  {order ? (
                    <BillPanel
                      order={order}
                      access={access}
                      onReprint={(ticketId) => printTicket(order, ticketId)}
                      onVoided={afterWrite}
                      onClosed={reload}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('pos.order.noOrder')}</p>
                  )}
                </TabsContent>
              </Tabs>
            </Card>
          </div>
          {access.canTake && cart.length > 0 && (
            <div
              className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-border bg-card p-3 shadow-lg lg:hidden"
              data-testid="send-bar"
            >
              <a
                href="#order-panel"
                className="flex min-w-0 flex-1 flex-col text-foreground no-underline"
                onClick={() => setPanel('cart')}
              >
                <span className="font-semibold tabular-nums">
                  {t('pos.order.cartSummary', {
                    count: String(cartCount),
                    total: money(cartTotal),
                  })}
                </span>
                <span className="text-sm text-primary-text">{t('pos.order.viewOrder')}</span>
              </a>
              <Button className="min-h-12" disabled={busy} onClick={() => void send()}>
                {t('pos.order.send')}
              </Button>
            </div>
          )}
          {print && (
            <PrintRoot>
              <KitchenTicketView
                key={print.at}
                ticket={print.ticket}
                tableName={table.name}
                orderNumber={print.orderNumber}
              />
            </PrintRoot>
          )}
        </div>
      )}
    </Loaded>
  );
}

function OrderHeader({
  table,
  order,
  now,
}: {
  table: Omit<FloorTable, 'order'>;
  order: Order | null;
  now: number;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button asChild variant="outline" size="icon">
        <Link href="/pos" aria-label={t('pos.order.back')}>
          <ArrowLeft aria-hidden />
        </Link>
      </Button>
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="text-2xl font-semibold">{t('pos.order.title', { table: table.name })}</h1>
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Users aria-hidden className="size-4" />
            {t('pos.floor.seats', { count: String(table.seats) })}
          </span>
          {table.area && <span>{table.area}</span>}
        </p>
      </div>
      {order && (
        <div className="flex flex-col items-end gap-1 text-sm">
          <Badge>{order.number}</Badge>
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Clock aria-hidden className="size-3.5" />
            {t('pos.order.opened', { minutes: String(minutesSince(order.openedAt, now)) })}
          </span>
        </div>
      )}
    </div>
  );
}

/** Search, category chips and the product grid; tiles show how many are in the cart. */
function Menu({
  tableId,
  cart,
  onAdd,
}: {
  tableId: string;
  cart: CartLine[];
  onAdd: (product: Product) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [menu, reloadMenu] = useResource(tableId, async () => {
    const [categories, products] = await Promise.all([loadCategories(store), loadProducts(store)]);
    if (!categories.ok) return categories;
    if (!products.ok) return products;
    return { ok: true as const, data: { categories: categories.data, products: products.data } };
  });
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const inCart = new Map(cart.map((l) => [l.product.id, l.quantity]));

  return (
    <section className="flex flex-col gap-4" aria-label={t('pos.order.menu')}>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <label htmlFor={`${id}-search`} className="sr-only">
          {t('pos.order.search')}
        </label>
        <Input
          id={`${id}-search`}
          type="search"
          className="pl-9"
          placeholder={t('pos.order.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <Loaded resource={menu} reload={reloadMenu}>
        {({ categories, products }) => (
          <MenuGrid
            categories={categories}
            products={products}
            category={category}
            query={query}
            inCart={inCart}
            onCategory={setCategory}
            onAdd={onAdd}
          />
        )}
      </Loaded>
    </section>
  );
}

function MenuGrid({
  categories,
  products,
  category,
  query,
  inCart,
  onCategory,
  onAdd,
}: {
  categories: ProductCategory[];
  products: Product[];
  category: string | null;
  query: string;
  inCart: ReadonlyMap<string, number>;
  onCategory: (id: string | null) => void;
  onAdd: (product: Product) => void;
}) {
  const t = useT();
  const needle = query.trim().toLocaleLowerCase();
  const matching = products.filter(
    (p) =>
      (category === null || p.categoryId === category) &&
      (needle === '' || p.name.toLocaleLowerCase().includes(needle)),
  );
  // Under category headings, in category order (only when showing more than one category).
  const groups = categories
    .map((c) => ({ category: c, products: matching.filter((p) => p.categoryId === c.id) }))
    .filter((g) => g.products.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <Button
          variant={category === null ? 'default' : 'outline'}
          className="shrink-0"
          aria-pressed={category === null}
          onClick={() => onCategory(null)}
        >
          {t('catalog.page.allCategories')}
        </Button>
        {categories.map((c) => (
          <Button
            key={c.id}
            variant={category === c.id ? 'default' : 'outline'}
            className="shrink-0"
            aria-pressed={category === c.id}
            onClick={() => onCategory(c.id)}
          >
            {c.name}
          </Button>
        ))}
      </div>
      {groups.length === 0 ? (
        <p className="text-muted-foreground">{t('pos.order.noResults')}</p>
      ) : (
        groups.map((group) => (
          <div key={group.category.id} className="flex flex-col gap-2">
            {category === null && (
              <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                {group.category.name}
              </h2>
            )}
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {group.products.map((product) => (
                <li key={product.id}>
                  <ProductTile
                    product={product}
                    count={inCart.get(product.id) ?? 0}
                    onAdd={onAdd}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

function ProductTile({
  product,
  count,
  onAdd,
}: {
  product: Product;
  count: number;
  onAdd: (product: Product) => void;
}) {
  const t = useT();
  const money = useMoney();
  return (
    <Button
      variant="outline"
      className={cn(
        'relative flex h-auto min-h-20 w-full flex-col items-start justify-between gap-2 whitespace-normal p-3 text-left',
        count > 0 && 'border-primary bg-primary/10 hover:bg-primary/15',
      )}
      data-testid="menu-product"
      data-name={product.name}
      onClick={() => onAdd(product)}
    >
      <span className="pr-8 font-medium leading-snug">{product.name}</span>
      <span className="text-sm text-muted-foreground tabular-nums">{money(product.price)}</span>
      {count > 0 && (
        <span
          className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
          data-testid="menu-count"
          aria-label={t('pos.order.inCart', { count: String(count) })}
        >
          {count}
        </span>
      )}
    </Button>
  );
}

/** The cart: quantity, line total and an optional note per item; the total and Clear. */
function Cart({
  cart,
  onChange,
  onClear,
  total,
}: {
  cart: CartLine[];
  onChange: (productId: string, patch: Partial<CartLine>) => void;
  onClear: () => void;
  total: string;
}) {
  const t = useT();
  const money = useMoney();
  if (cart.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">{t('pos.order.cartEmpty')}</p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border">
        {cart.map((line) => (
          <CartRow key={line.product.id} line={line} onChange={onChange} />
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <Button variant="ghost" onClick={onClear}>
          {t('pos.order.clear')}
        </Button>
        <span className="text-lg font-semibold tabular-nums" data-testid="cart-total">
          {t('pos.order.total')} {money(total)}
        </span>
      </div>
    </div>
  );
}

function CartRow({
  line,
  onChange,
}: {
  line: CartLine;
  onChange: (productId: string, patch: Partial<CartLine>) => void;
}) {
  const t = useT();
  const money = useMoney();
  const id = useId();
  const name = line.product.name;
  const [noteOpen, setNoteOpen] = useState(line.note !== '');
  return (
    <li className="flex flex-col gap-2 py-2" data-testid="cart-line" data-name={name}>
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-md border border-border">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('pos.order.decrease', { name })}
            onClick={() => onChange(line.product.id, { quantity: line.quantity - 1 })}
          >
            <Minus aria-hidden />
          </Button>
          <span className="w-7 text-center font-semibold tabular-nums" data-testid="cart-quantity">
            {line.quantity}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('pos.order.increase', { name })}
            disabled={line.quantity >= ORDER_LINE_MAX_QUANTITY}
            onClick={() => onChange(line.product.id, { quantity: line.quantity + 1 })}
          >
            <Plus aria-hidden />
          </Button>
        </div>
        <span className="min-w-0 flex-1 font-medium leading-snug">{name}</span>
        <span className="tabular-nums">{money(times(line.product.price, line.quantity))}</span>
      </div>
      {noteOpen ? (
        <>
          <label htmlFor={`${id}-note`} className="sr-only">
            {t('pos.order.note', { name })}
          </label>
          <Input
            id={`${id}-note`}
            autoFocus
            value={line.note}
            maxLength={ORDER_NOTE_MAX_LENGTH}
            placeholder={t('pos.order.note', { name })}
            onChange={(e) => onChange(line.product.id, { note: e.target.value })}
          />
        </>
      ) : (
        <Button
          variant="ghost"
          className="min-h-8 self-start gap-1 px-2 text-sm text-muted-foreground"
          onClick={() => setNoteOpen(true)}
        >
          <StickyNote aria-hidden className="size-4" />
          {t('pos.order.addNote')}
        </Button>
      )}
    </li>
  );
}
