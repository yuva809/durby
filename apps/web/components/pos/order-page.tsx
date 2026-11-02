'use client';

import {
  type FloorTable,
  type KitchenTicket,
  type Order,
  ORDER_LINE_MAX_QUANTITY,
  ORDER_MAX_COVERS,
  ORDER_NOTE_MAX_LENGTH,
  type Product,
  type ProductCategory,
  type SendTicketResponse,
  TABLE_COLORS,
} from '@durby/shared';
import { ArrowLeft, ChefHat, Minus, Plus, Printer, Search, StickyNote, Users } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories, loadProducts } from '../../lib/catalog/api';
import { closeOrder, loadTableOrder, sendTicket, updateOrder } from '../../lib/pos/api';
import {
  type BillLine,
  billLines,
  durationLabel,
  minutesSince,
  rate,
  sum,
  times,
} from '../../lib/pos/format';
import { useNow } from '../../lib/pos/use-now';
import { printAs } from '../../lib/pos/print';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { KitchenTicketView, OrderSlip, PrintRoot } from './kitchen-ticket';
import { MoneyProvider, useMoney } from './money';
import { Receipt } from './receipt';
import { tableColors } from './table-icon';
import { VoidDialog } from './void-dialog';

interface OrderAccess {
  canTake: boolean;
  canVoid: boolean;
  canClose: boolean;
  /** pos.bills.print: the bill with prices; without it the till prints the order only. */
  canPrintBill: boolean;
}

/** /service/[tableId]: the till for one table (docs/modules/pos.md → Web). */
export function OrderPage({ tableId }: { tableId: string }) {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('pos.orders.read')) return <NoAccess title="pos.nav.service" />;
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
          canPrintBill: permissions.has('pos.bills.print'),
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
  | { kind: 'bill' | 'slip'; seq: number };

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  // Guests chosen before the table has an order: they go with the first send.
  const [pendingCovers, setPendingCovers] = useState<number | null>(null);

  useEffect(() => {
    if (print) printAs(organizationName);
  }, [print, organizationName]);

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
      ...(pendingCovers === null ? {} : { covers: pendingCovers }),
    });
    setBusy(false);
    if (result.ok && result.data) {
      const ticket = result.data.order.tickets.find((x) => x.id === result.data?.ticketId);
      setCart([]);
      setPendingCovers(null);
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
        const sendAction =
          cart.length > 0 && access.canTake
            ? {
                label: `${t('pos.order.sendCount', { count: String(cartCount) })} · ${money(cartTotal)}`,
                short: t('pos.order.send'),
                run: () => void send(),
                testId: 'send-to-kitchen',
                icon: <ChefHat aria-hidden />,
              }
            : null;
        const printAction =
          order && order.totals.itemCount > 0
            ? access.canPrintBill
              ? {
                  label: t('pos.order.printBill'),
                  short: t('pos.order.printBill'),
                  run: () => setPrint((prev) => ({ kind: 'bill', seq: (prev?.seq ?? 0) + 1 })),
                  testId: 'print-bill',
                  icon: <Printer aria-hidden />,
                }
              : {
                  // Waiters print the order only: no prices, VAT or total.
                  label: t('pos.order.printOrder'),
                  short: t('pos.order.printOrder'),
                  run: () => setPrint((prev) => ({ kind: 'slip', seq: (prev?.seq ?? 0) + 1 })),
                  testId: 'print-order',
                  icon: <Printer aria-hidden />,
                }
            : null;
        const barAction = sendAction ?? printAction;

        return (
          <div className={cn('flex flex-col gap-5', barAction && 'pb-24 lg:pb-0')}>
            <OrderHeader
              table={table}
              order={order}
              now={now}
              actions={
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
                access.canTake ? 'lg:grid-cols-[minmax(0,1fr)_23rem]' : 'mx-auto w-full max-w-lg',
              )}
            >
              {access.canTake && <Menu tableId={tableId} cart={cart} onAdd={add} />}
              <aside
                id="order-panel"
                className="flex flex-col gap-4 lg:sticky lg:top-4"
                aria-label={t('pos.order.panel')}
              >
                {access.canTake && (
                  <GuestsField
                    key={`${order?.id ?? 'new'}:${order?.covers ?? ''}`}
                    order={order}
                    pending={pendingCovers}
                    onPending={setPendingCovers}
                    onSaved={reload}
                  />
                )}
                {access.canTake && (
                  <NewItems
                    cart={cart}
                    total={cartTotal}
                    onChange={change}
                    onClear={() => setCart([])}
                    footer={
                      <>
                        <Notice text={error} tone="error" />
                        {sendAction && (
                          <Button
                            className="hidden min-h-12 gap-2 text-base lg:flex"
                            disabled={busy}
                            onClick={sendAction.run}
                            data-testid={sendAction.testId}
                          >
                            {sendAction.icon}
                            {sendAction.label}
                          </Button>
                        )}
                      </>
                    }
                  />
                )}
                <OnTheTable
                  order={order}
                  bill={bill}
                  notice={sent}
                  voidButton={
                    order &&
                    order.status === 'open' &&
                    access.canVoid &&
                    order.totals.itemCount > 0 ? (
                      <VoidDialog order={order} onVoided={afterWrite} />
                    ) : null
                  }
                  printButton={
                    printAction && (
                      <Button
                        variant={sendAction ? 'outline' : 'default'}
                        className="hidden min-h-11 gap-2 lg:flex"
                        onClick={printAction.run}
                        data-testid={printAction.testId}
                      >
                        {printAction.icon}
                        {printAction.label}
                      </Button>
                    )
                  }
                />
                {order && order.tickets.length > 0 && (
                  <TicketLog order={order} onReprint={(id) => printTicket(order, id)} />
                )}
              </aside>
            </div>
            {barAction && (
              <div
                className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-border bg-card p-3 shadow-lg lg:hidden"
                data-testid="send-bar"
              >
                <a
                  href="#order-panel"
                  className="flex min-w-0 flex-1 flex-col text-foreground no-underline"
                >
                  <span className="font-semibold tabular-nums">
                    {sendAction
                      ? `${t('pos.order.itemCount', { count: String(cartCount) })} · ${money(cartTotal)}`
                      : `${t('pos.order.itemCount', { count: String(order?.totals.itemCount ?? 0) })} · ${money(order?.totals.gross ?? '0.00')}`}
                  </span>
                  <span className="text-sm text-primary-text">{t('pos.order.viewOrder')}</span>
                </a>
                <Button className="min-h-12 gap-2" disabled={busy} onClick={barAction.run}>
                  {barAction.icon}
                  {barAction.short}
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
                ) : print.kind === 'slip' ? (
                  <OrderSlip
                    key={print.seq}
                    organizationName={organizationName}
                    tableName={table.name}
                    orderNumber={order?.number ?? ''}
                    lines={bill}
                    printedAt={new Date(now)}
                  />
                ) : (
                  <div key={print.seq} data-testid="printed-bill">
                    <Receipt
                      organizationName={organizationName}
                      tableName={table.name}
                      order={order}
                      bill={bill}
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

/** Back, the table with a status dot in its colour, a quiet meta line, and the order actions. */
function OrderHeader({
  table,
  order,
  now,
  actions,
}: {
  table: Omit<FloorTable, 'order'>;
  order: Order | null;
  now: number;
  actions: ReactNode;
}) {
  const t = useT();
  const duration = order ? durationLabel(minutesSince(order.openedAt, now)) : null;
  const meta = [
    t('pos.floor.seats', { count: String(table.seats) }),
    table.area,
    order && duration
      ? t('pos.tablesPage.open', { duration: t(duration.key, duration.values) })
      : null,
    order?.covers ? t('pos.order.guestCount', { count: String(order.covers) }) : null,
    order?.number,
  ].filter((x): x is string => Boolean(x));
  return (
    <header className="flex flex-wrap items-center gap-4" data-testid="table-bar">
      <Button asChild variant="outline" size="icon" className="rounded-full">
        <Link href="/service" aria-label={t('pos.order.back')}>
          <ArrowLeft aria-hidden />
        </Link>
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          <span
            aria-hidden
            className="size-3 rounded-full"
            style={{ backgroundColor: tableColors(table.color).stroke }}
          />
          {table.name}
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              order ? 'bg-primary/15 text-primary-text' : 'bg-muted text-muted-foreground',
            )}
          >
            {t(order ? 'pos.floor.open' : 'pos.floor.free')}
          </span>
        </h1>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <Users aria-hidden className="size-3.5" />
          {meta.join(' · ')}
        </p>
      </div>
      {actions}
    </header>
  );
}

/**
 * Guests at the table (docs/modules/pos.md → Covers): − n +. Before the table has an order the value
 * goes with the first send; on an open order Save writes it (one audited change, not one per tap).
 * Below one it is empty.
 */
function GuestsField({
  order,
  pending,
  onPending,
  onSaved,
}: {
  order: Order | null;
  pending: number | null;
  onPending: (covers: number | null) => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const labelId = useId();
  const [draft, setDraft] = useState<number | null>(order ? order.covers : pending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: number | null) => {
    setDraft(next);
    if (!order) onPending(next);
  };
  async function save() {
    if (!order) return;
    setBusy(true);
    setError(null);
    const result = await updateOrder(store, action, order.id, { covers: draft });
    setBusy(false);
    if (result.ok) onSaved();
    else setError(t(errorLabel(result.code)));
  }

  return (
    <Card className="flex flex-col gap-2 p-3" data-testid="guests">
      <div className="flex items-center gap-2">
        <span id={labelId} className="flex flex-1 items-center gap-2 text-sm font-medium">
          <Users aria-hidden className="size-4" />
          {t('pos.order.guests')}
        </span>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('pos.order.fewerGuests')}
          disabled={draft === null || busy}
          onClick={() => change(draft !== null && draft > 1 ? draft - 1 : null)}
        >
          <Minus aria-hidden />
        </Button>
        <output
          aria-labelledby={labelId}
          className="w-8 text-center text-lg font-semibold tabular-nums"
          data-testid="guests-value"
        >
          {draft ?? '–'}
        </output>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('pos.order.moreGuests')}
          disabled={draft === ORDER_MAX_COVERS || busy}
          onClick={() => change(Math.min((draft ?? 0) + 1, ORDER_MAX_COVERS))}
        >
          <Plus aria-hidden />
        </Button>
        {order && draft !== order.covers && (
          <Button disabled={busy} onClick={() => void save()}>
            {t('platform.common.save')}
          </Button>
        )}
      </div>
      <Notice text={error} tone="error" />
    </Card>
  );
}

/** The items being added: − qty +, note, line total; Clear and the send button below. */
function NewItems({
  cart,
  total,
  onChange,
  onClear,
  footer,
}: {
  cart: CartLine[];
  total: string;
  onChange: (productId: string, patch: Partial<CartLine>) => void;
  onClear: () => void;
  footer: ReactNode;
}) {
  const t = useT();
  const money = useMoney();
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="new-items">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{t('pos.order.cart')}</h2>
        {cart.length > 0 && (
          <Button variant="ghost" className="min-h-8 px-2 text-sm" onClick={onClear}>
            {t('pos.order.clearCart')}
          </Button>
        )}
      </div>
      {cart.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
          {t('pos.order.cartEmpty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {cart.map((line) => (
              <CartRow key={line.product.id} line={line} onChange={onChange} />
            ))}
          </ul>
          <p className="flex justify-between border-t border-border pt-2 text-sm">
            <span className="text-muted-foreground">{t('pos.order.total')}</span>
            <span className="font-semibold tabular-nums" data-testid="cart-total">
              {money(total)}
            </span>
          </p>
        </>
      )}
      {footer}
    </Card>
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
    <li className="flex flex-col gap-2" data-testid="cart-line" data-name={name}>
      <div className="flex items-center gap-3">
        <div className="flex items-center rounded-full bg-muted p-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            aria-label={t('pos.order.decrease', { name })}
            onClick={() => onChange(line.product.id, { quantity: line.quantity - 1 })}
          >
            <Minus aria-hidden className="size-4" />
          </Button>
          <span
            className="w-6 text-center text-sm font-semibold tabular-nums"
            data-testid="cart-quantity"
          >
            {line.quantity}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            aria-label={t('pos.order.increase', { name })}
            disabled={line.quantity >= ORDER_LINE_MAX_QUANTITY}
            onClick={() => onChange(line.product.id, { quantity: line.quantity + 1 })}
          >
            <Plus aria-hidden className="size-4" />
          </Button>
        </div>
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{name}</span>
        <span className="text-sm tabular-nums">
          {money(times(line.product.price, line.quantity))}
        </span>
      </div>
      {noteOpen ? (
        <>
          <label htmlFor={`${id}-note`} className="sr-only">
            {t('pos.order.note', { name })}
          </label>
          <Input
            id={`${id}-note`}
            autoFocus
            className="h-9 text-sm"
            value={line.note}
            maxLength={ORDER_NOTE_MAX_LENGTH}
            placeholder={t('pos.order.note', { name })}
            onChange={(e) => onChange(line.product.id, { note: e.target.value })}
          />
        </>
      ) : (
        <button
          type="button"
          className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setNoteOpen(true)}
        >
          <StickyNote aria-hidden className="size-3.5" />
          {t('pos.order.noteToggle', { name })}
        </button>
      )}
    </li>
  );
}

/** What the table has: combined items, VAT split, total, and the print and void actions. */
function OnTheTable({
  order,
  bill,
  notice,
  voidButton,
  printButton,
}: {
  order: Order | null;
  bill: BillLine[];
  notice: string | null;
  voidButton: ReactNode;
  printButton: ReactNode;
}) {
  const t = useT();
  const money = useMoney();
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="order-view">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{t('pos.order.onTable')}</h2>
        {voidButton}
      </div>
      <Notice text={notice} tone="info" />
      {bill.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pos.order.noOrder')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {bill.map((line) => (
            <li
              key={line.key}
              className="flex items-start justify-between gap-3 text-sm"
              data-testid="bill-line"
              data-name={line.name}
            >
              <span className="flex min-w-0 gap-2">
                <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-muted-foreground">
                  {line.quantity}×
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{line.name}</span>
                  {line.note && <span className="text-xs text-muted-foreground">{line.note}</span>}
                </span>
              </span>
              <span className="tabular-nums">{money(line.total)}</span>
            </li>
          ))}
        </ul>
      )}
      {order && order.totals.itemCount > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2.5">
          {order.totals.byTaxRate.map((r) => (
            <p key={r.taxRate} className="flex justify-between text-xs text-muted-foreground">
              <span>{t('pos.bill.vatShort', { rate: rate(r.taxRate) })}</span>
              <span className="tabular-nums">
                {money(r.net)} + {money(r.tax)}
              </span>
            </p>
          ))}
          <p className="flex items-baseline justify-between pt-1">
            <span className="text-sm font-medium">{t('pos.order.total')}</span>
            <span
              className="text-2xl font-semibold tracking-tight tabular-nums"
              data-testid="order-total"
            >
              {money(order.totals.gross)}
            </span>
          </p>
        </div>
      )}
      {printButton}
    </Card>
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

/** A category rail (side list on wide screens, a scrolling row on phones), search and product cards. */
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

  // "/" focuses the search; not while typing elsewhere.
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
    <Loaded resource={menu} reload={reloadMenu}>
      {({ categories, products }) => (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[11rem_minmax(0,1fr)]">
          <CategoryRail
            categories={categories}
            products={products}
            category={category}
            onCategory={setCategory}
          />
          <section className="flex min-w-0 flex-col gap-4" aria-label={t('pos.order.menu')}>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <label htmlFor={`${id}-search`} className="sr-only">
                {t('pos.order.search')}
              </label>
              <Input
                ref={search}
                id={`${id}-search`}
                type="search"
                className="h-11 pl-9"
                placeholder={t('pos.order.searchHint')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <ProductGrid
              categories={categories}
              products={products}
              category={category}
              query={query}
              inCart={inCart}
              onAdd={onAdd}
            />
          </section>
        </div>
      )}
    </Loaded>
  );
}

function CategoryRail({
  categories,
  products,
  category,
  onCategory,
}: {
  categories: ProductCategory[];
  products: Product[];
  category: string | null;
  onCategory: (id: string | null) => void;
}) {
  const t = useT();
  const countOf = (id: string) => products.filter((p) => p.categoryId === id).length;
  const item = (key: string | null, label: string, count: number) => {
    const active = category === key;
    return (
      <button
        key={key ?? 'all'}
        type="button"
        aria-pressed={active}
        onClick={() => onCategory(key)}
        className={cn(
          'flex min-h-11 shrink-0 items-center justify-between gap-3 rounded-md px-3 text-left text-sm transition-colors lg:border-l-2',
          active
            ? 'bg-card font-semibold text-foreground shadow-sm lg:border-primary'
            : 'text-muted-foreground hover:bg-card hover:text-foreground lg:border-transparent',
        )}
      >
        <span>{label}</span>
        <span className="text-xs tabular-nums">{count}</span>
      </button>
    );
  };
  return (
    <nav
      aria-label={t('pos.order.categories')}
      className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1 lg:sticky lg:top-4 lg:flex-col lg:overflow-visible"
      data-testid="category-chips"
    >
      {item(null, t('catalog.page.allCategories'), products.length)}
      {categories.map((c) => item(c.id, c.name, countOf(c.id)))}
    </nav>
  );
}

function ProductGrid({
  categories,
  products,
  category,
  query,
  inCart,
  onAdd,
}: {
  categories: ProductCategory[];
  products: Product[];
  category: string | null;
  query: string;
  inCart: ReadonlyMap<string, number>;
  onAdd: (product: Product) => void;
}) {
  const t = useT();
  const needle = query.trim().toLocaleLowerCase();
  const matching = products.filter(
    (p) =>
      (category === null || p.categoryId === category) &&
      (needle === '' || p.name.toLocaleLowerCase().includes(needle)),
  );
  // Each category gets a tile colour from the table palette, in category order.
  const colorOf = new Map(
    categories.map((c, i) => [c.id, TABLE_COLORS[(i % (TABLE_COLORS.length - 1)) + 1]!]),
  );
  const groups = categories
    .map((c) => ({ category: c, products: matching.filter((p) => p.categoryId === c.id) }))
    .filter((g) => g.products.length > 0);

  if (groups.length === 0)
    return <p className="text-muted-foreground">{t('pos.order.noResults')}</p>;
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.category.id} className="flex flex-col gap-2">
          {category === null && (
            <h2 className="text-sm font-semibold text-muted-foreground">{group.category.name}</h2>
          )}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {group.products.map((product) => (
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
        </div>
      ))}
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
        'relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2',
        count > 0 ? 'border-primary ring-1 ring-primary' : 'border-border',
      )}
      data-testid="menu-product"
      data-name={product.name}
      onClick={() => onAdd(product)}
    >
      <span
        aria-hidden
        className="flex h-16 items-center justify-center text-2xl font-semibold"
        style={{ backgroundColor: fill, color: stroke }}
      >
        {product.name.slice(0, 1).toLocaleUpperCase()}
      </span>
      <span className="flex flex-1 flex-col justify-between gap-1 p-3">
        <span className="line-clamp-2 text-sm leading-snug font-medium" title={product.name}>
          {product.name}
        </span>
        <span className="text-sm text-muted-foreground tabular-nums">{money(product.price)}</span>
      </span>
      {count > 0 && (
        <span
          className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground shadow"
          data-testid="menu-count"
          aria-label={t('pos.order.inCart', { count: String(count) })}
        >
          {count}
        </span>
      )}
    </button>
  );
}
