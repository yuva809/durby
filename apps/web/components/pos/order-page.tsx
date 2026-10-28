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
  TABLE_COLORS,
} from '@durby/shared';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock,
  Minus,
  Plus,
  Printer,
  Search,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories, loadProducts } from '../../lib/catalog/api';
import { closeOrder, loadTableOrder, sendTicket } from '../../lib/pos/api';
import { billLines, durationLabel, minutesSince, sum, times } from '../../lib/pos/format';
import { useNow } from '../../lib/pos/use-now';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { KitchenTicketView, PrintRoot } from './kitchen-ticket';
import { MoneyProvider, useMoney } from './money';
import { type PendingLine, Receipt, type ReceiptSelection } from './receipt';
import { TableIcon, tableColors } from './table-icon';
import { VoidDialog } from './void-dialog';

interface OrderAccess {
  canTake: boolean;
  canVoid: boolean;
  canClose: boolean;
}

/** /pos/order/[tableId]: the till for one table (docs/modules/pos.md → Web). */
export function OrderPage({ tableId }: { tableId: string }) {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('pos.orders.read')) return <NoAccess title="pos.nav.title" />;
  const organizationName =
    session.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? '';
  return (
    <MoneyProvider>
      <TableOrder
        tableId={tableId}
        organizationName={organizationName}
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

/** What to print; `seq` grows with every request, so a reprint prints again. */
type PrintJob =
  | { kind: 'ticket'; ticket: KitchenTicket; orderNumber: string; seq: number }
  | { kind: 'bill'; seq: number };

function TableOrder({
  tableId,
  organizationName,
  access,
}: {
  tableId: string;
  organizationName: string;
  access: OrderAccess;
}) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const action = useActionKey();
  const closeAction = useActionKey();
  const [view, reload] = useResource(tableId, () => loadTableOrder(store, tableId));
  const now = useNow(30_000);
  const [print, setPrint] = useState<PrintJob | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<ReceiptSelection>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (print) window.print();
  }, [print]);

  const printTicket = (order: Order, ticketId: string) => {
    const ticket = order.tickets.find((x) => x.id === ticketId);
    if (ticket) {
      setPrint((prev) => ({
        kind: 'ticket',
        ticket,
        orderNumber: order.number,
        seq: (prev?.seq ?? 0) + 1,
      }));
    }
  };
  const afterWrite = (response: SendTicketResponse) => {
    reload();
    printTicket(response.order, response.ticketId);
  };

  const add = (product: Product) => {
    setSent(null);
    setSelected({ kind: 'new', key: product.id });
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
      setSelected(null);
      setSent(t('pos.order.sent', { sequence: String(ticket?.sequence ?? '') }));
      afterWrite(result.data);
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <Loaded resource={view} reload={reload}>
      {({ table, order }) => {
        const bill = order ? billLines(order) : [];
        const pending: PendingLine[] = cart.map((l) => ({
          key: l.product.id,
          name: l.product.name,
          note: l.note,
          quantity: l.quantity,
          unitPrice: l.product.price,
          total: times(l.product.price, l.quantity),
        }));
        const grandTotal = sum([order?.totals.gross ?? '0.00', cartTotal]);
        const itemCount = (order?.totals.itemCount ?? 0) + cartCount;
        const main =
          cart.length > 0 && access.canTake
            ? {
                label: `${t('pos.order.sendCount', { count: String(cartCount) })} · ${money(cartTotal)}`,
                run: () => void send(),
                testId: 'send-to-kitchen',
                icon: null,
              }
            : order && order.totals.itemCount > 0
              ? {
                  label: `${t('pos.order.printBill')} · ${money(order.totals.gross)}`,
                  run: () => setPrint((prev) => ({ kind: 'bill', seq: (prev?.seq ?? 0) + 1 })),
                  testId: 'print-bill',
                  icon: <Printer aria-hidden />,
                }
              : null;

        const receiptProps = {
          organizationName,
          tableName: table.name,
          order,
          bill,
          pending,
          pendingTotal: cartTotal,
          grandTotal,
        };

        return (
          <div className={cn('flex flex-col gap-4', main && 'pb-24 lg:pb-0')}>
            <TableBar
              table={table}
              order={order}
              now={now}
              pending={access.canTake ? cartCount : 0}
              busy={busy}
              onSend={() => void send()}
              closeButton={
                order && order.status === 'open' && access.canClose ? (
                  <ConfirmAction
                    testId="close-order"
                    trigger={t('pos.order.close')}
                    title={t('pos.order.closeTitle', { number: order.number })}
                    description={t('pos.order.closeDescription')}
                    confirm={t('pos.order.close')}
                    run={() => closeOrder(store, closeAction, order.id)}
                    onDone={reload}
                  />
                ) : null
              }
            />
            <div
              className={cn(
                'grid items-start gap-5',
                access.canTake ? 'lg:grid-cols-[1fr_25rem]' : 'mx-auto w-full max-w-md',
              )}
            >
              {access.canTake && <Menu tableId={tableId} cart={cart} onAdd={add} />}
              <aside
                id="order-panel"
                className="flex flex-col gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]"
                aria-label={t('pos.bill.preview')}
              >
                <Card className="flex min-h-0 flex-col gap-3 p-4">
                  <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <span>{t('pos.bill.preview')}</span>
                    <span>{t('pos.order.itemCount', { count: String(itemCount) })}</span>
                  </div>
                  <div className="min-h-0 overflow-y-auto">
                    <Receipt
                      {...receiptProps}
                      printedAt={new Date(now)}
                      selected={selected}
                      onSelect={setSelected}
                      controls={
                        selected?.kind === 'new' ? (
                          <PendingControls
                            line={cart.find((l) => l.product.id === selected.key)}
                            onChange={change}
                          />
                        ) : selected?.kind === 'sent' && order && access.canVoid ? (
                          <div className="flex justify-end px-2 pb-2">
                            <VoidDialog order={order} onVoided={afterWrite} />
                          </div>
                        ) : null
                      }
                    />
                  </div>
                  <Notice text={error} tone="error" />
                  <Notice text={sent} tone="info" />
                  {main && (
                    <Button
                      className="hidden min-h-12 gap-2 text-base lg:flex"
                      disabled={busy}
                      onClick={main.run}
                      data-testid={main.testId}
                    >
                      {main.icon}
                      {main.label}
                    </Button>
                  )}
                </Card>
                {order && order.tickets.length > 0 && (
                  <TicketLog order={order} onReprint={(id) => printTicket(order, id)} />
                )}
              </aside>
            </div>
            {main && (
              <div
                className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-border bg-card p-3 shadow-lg lg:hidden"
                data-testid="send-bar"
              >
                <a
                  href="#order-panel"
                  className="flex min-w-0 flex-1 flex-col text-foreground no-underline"
                >
                  <span className="font-semibold tabular-nums">
                    {t('pos.order.itemCount', { count: String(itemCount) })} · {money(grandTotal)}
                  </span>
                  <span className="text-sm text-primary-text">{t('pos.order.viewOrder')}</span>
                </a>
                <Button className="min-h-12 gap-2" disabled={busy} onClick={main.run}>
                  {main.icon}
                  {main.testId === 'print-bill' ? t('pos.order.printBill') : t('pos.order.send')}
                </Button>
              </div>
            )}
            {print && (
              <PrintRoot>
                {print.kind === 'ticket' ? (
                  <KitchenTicketView
                    key={print.seq}
                    ticket={print.ticket}
                    tableName={table.name}
                    orderNumber={print.orderNumber}
                  />
                ) : (
                  <div key={print.seq} data-testid="printed-bill">
                    <Receipt
                      {...receiptProps}
                      pending={[]}
                      pendingTotal="0.00"
                      grandTotal={order?.totals.gross ?? '0.00'}
                      printedAt={new Date(now)}
                    />
                  </div>
                )}
              </PrintRoot>
            )}
          </div>
        );
      }}
    </Loaded>
  );
}

function TableBar({
  table,
  order,
  now,
  pending,
  busy,
  onSend,
  closeButton,
}: {
  table: Omit<FloorTable, 'order'>;
  order: Order | null;
  now: number;
  pending: number;
  busy: boolean;
  onSend: () => void;
  closeButton: React.ReactNode;
}) {
  const t = useT();
  const duration = order ? durationLabel(minutesSince(order.openedAt, now)) : null;
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3" data-testid="table-bar">
      <Button asChild variant="outline" className="gap-2">
        <Link href="/pos">
          <ArrowLeft aria-hidden className="size-4" />
          {t('pos.order.back')}
        </Link>
      </Button>
      <TableIcon shape={table.shape} color={table.color} className="size-9" />
      <h1 className="text-xl font-semibold">{table.name}</h1>
      <span
        className={cn(
          'rounded-full px-2.5 py-0.5 text-xs font-medium',
          order ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        {t(order ? 'pos.floor.open' : 'pos.floor.free')}
      </span>
      {order && duration && (
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <Clock aria-hidden className="size-3.5" />
          {t('pos.tablesPage.open', { duration: t(duration.key, duration.values) })} ·{' '}
          {order.number}
        </span>
      )}
      {pending > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={onSend}
          data-testid="to-send"
          className="rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm font-medium text-primary-text"
        >
          {t('pos.order.toSend', { count: String(pending) })}
        </button>
      )}
      <span className="ml-auto">{closeButton}</span>
    </Card>
  );
}

/** − quantity + / note / remove for a selected NEW line. */
function PendingControls({
  line,
  onChange,
}: {
  line: CartLine | undefined;
  onChange: (productId: string, patch: Partial<CartLine>) => void;
}) {
  const t = useT();
  const id = useId();
  if (!line) return null;
  const name = line.product.name;
  return (
    <div className="flex flex-col gap-2 px-2 pb-2 font-sans text-sm" data-testid="line-controls">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label={t('pos.order.decrease', { name })}
          onClick={() => onChange(line.product.id, { quantity: line.quantity - 1 })}
        >
          <Minus aria-hidden />
        </Button>
        <span className="w-8 text-center font-semibold tabular-nums" data-testid="cart-quantity">
          {line.quantity}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('pos.order.increase', { name })}
          disabled={line.quantity >= ORDER_LINE_MAX_QUANTITY}
          onClick={() => onChange(line.product.id, { quantity: line.quantity + 1 })}
        >
          <Plus aria-hidden />
        </Button>
        <Button
          variant="ghost"
          className="ml-auto gap-1 text-destructive"
          onClick={() => onChange(line.product.id, { quantity: 0 })}
        >
          <Trash2 aria-hidden className="size-4" />
          {t('pos.order.remove')}
        </Button>
      </div>
      <label htmlFor={`${id}-note`} className="sr-only">
        {t('pos.order.note', { name })}
      </label>
      <Input
        id={`${id}-note`}
        value={line.note}
        maxLength={ORDER_NOTE_MAX_LENGTH}
        placeholder={t('pos.order.note', { name })}
        onChange={(e) => onChange(line.product.id, { note: e.target.value })}
      />
    </div>
  );
}

function TicketLog({ order, onReprint }: { order: Order; onReprint: (ticketId: string) => void }) {
  const t = useT();
  const money = useMoney();
  return (
    <details className="rounded-lg border border-border bg-card">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium">
        {t('pos.bill.tickets', { count: String(order.tickets.length) })}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border p-4">
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
  );
}

/** Search, category chips with counts, and the product cards. */
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
  const search = useRef<HTMLInputElement>(null);
  const [menu, reloadMenu] = useResource(tableId, async () => {
    const [categories, products] = await Promise.all([loadCategories(store), loadProducts(store)]);
    if (!categories.ok) return categories;
    if (!products.ok) return products;
    return { ok: true as const, data: { categories: categories.data, products: products.data } };
  });
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const inCart = new Map(cart.map((l) => [l.product.id, l.quantity]));

  // "/" focuses the search, like the reference till; not while typing elsewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
      if (event.key === '/' && !typing) {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={t('pos.order.menu')}>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <label htmlFor={`${id}-search`} className="sr-only">
          {t('pos.order.search')}
        </label>
        <Input
          ref={search}
          id={`${id}-search`}
          type="search"
          className="h-12 rounded-full pr-12 pl-11"
          placeholder={t('pos.order.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 rounded border border-border px-1.5 text-xs text-muted-foreground">
          /
        </kbd>
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
  const chips = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLocaleLowerCase();
  const shown = products.filter(
    (p) =>
      (category === null || p.categoryId === category) &&
      (needle === '' || p.name.toLocaleLowerCase().includes(needle)),
  );
  const countOf = (id: string) => products.filter((p) => p.categoryId === id).length;
  // Each category gets a tile colour from the table palette, in category order.
  const colorOf = new Map(
    categories.map((c, i) => [c.id, TABLE_COLORS[(i % (TABLE_COLORS.length - 1)) + 1]!]),
  );
  const scroll = (direction: 1 | -1) =>
    chips.current?.scrollBy({ left: direction * 240, behavior: 'smooth' });
  const current = categories.find((c) => c.id === category);

  const chip = (id: string | null, label: string, count: number) => (
    <Button
      key={id ?? 'all'}
      variant={category === id ? 'default' : 'outline'}
      className="shrink-0 gap-2 rounded-full"
      aria-pressed={category === id}
      onClick={() => onCategory(id)}
    >
      {label}
      <span className={cn('text-xs', category === id ? 'opacity-80' : 'text-muted-foreground')}>
        {count}
      </span>
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="hidden shrink-0 rounded-full sm:flex"
          aria-label={t('pos.order.scrollLeft')}
          onClick={() => scroll(-1)}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <div
          ref={chips}
          className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1"
          data-testid="category-chips"
        >
          {chip(null, t('catalog.page.allCategories'), products.length)}
          {categories.map((c) => chip(c.id, c.name, countOf(c.id)))}
        </div>
        <Button
          variant="outline"
          size="icon"
          className="hidden shrink-0 rounded-full sm:flex"
          aria-label={t('pos.order.scrollRight')}
          onClick={() => scroll(1)}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
      <div className="flex justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span data-testid="product-count">
          {(current?.name ?? t('pos.order.allProducts')) + ' · ' + String(shown.length)}
        </span>
        <span className="normal-case">{t('pos.order.tapToAdd')}</span>
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground">{t('pos.order.noResults')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {shown.map((product) => (
            <li key={product.id}>
              <ProductCard
                product={product}
                count={inCart.get(product.id) ?? 0}
                color={colorOf.get(product.categoryId) ?? 'neutral'}
                onAdd={onAdd}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProductCard({
  product,
  count,
  color,
  onAdd,
}: {
  product: Product;
  count: number;
  color: (typeof TABLE_COLORS)[number];
  onAdd: (product: Product) => void;
}) {
  const t = useT();
  const money = useMoney();
  const { stroke, fill } = tableColors(color);
  return (
    <button
      type="button"
      className={cn(
        'relative flex h-full w-full items-center gap-3 rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:bg-muted focus-visible:outline-2',
        count > 0 ? 'border-primary' : 'border-border',
      )}
      data-testid="menu-product"
      data-name={product.name}
      onClick={() => onAdd(product)}
    >
      <span
        aria-hidden
        className="flex size-14 shrink-0 items-center justify-center rounded-md text-xl font-bold"
        style={{ backgroundColor: fill, color: stroke }}
      >
        {product.name.slice(0, 1).toLocaleUpperCase()}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="line-clamp-2 leading-snug font-medium" title={product.name}>
          {product.name}
        </span>
        <span className="text-sm text-muted-foreground tabular-nums">{money(product.price)}</span>
      </span>
      {count > 0 && (
        <span
          className="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
          data-testid="menu-count"
          aria-label={t('pos.order.inCart', { count: String(count) })}
        >
          {count}
        </span>
      )}
    </button>
  );
}
