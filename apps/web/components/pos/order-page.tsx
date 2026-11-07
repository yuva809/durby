'use client';

import {
  type EffectivePrice,
  type FloorTable,
  type KitchenTicket,
  type Order,
  ORDER_LINE_MAX_QUANTITY,
  ORDER_MAX_COVERS,
  ORDER_NOTE_MAX_LENGTH,
  type PrepStation,
  type Product,
  type ProductCategory,
  type SendTicketResponse,
  type StationProcessing,
  TABLE_COLORS,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import {
  ArrowLeft,
  Check,
  ChefHat,
  Minus,
  Plus,
  Printer,
  ReceiptText,
  Search,
  StickyNote,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories, loadProducts } from '../../lib/catalog/api';
import { loadPrices } from '../../lib/catalog/prices-api';
import {
  closeOrder,
  loadBillLayout,
  loadTableOrder,
  sendTicket,
  serveTicket,
  updateOrder,
} from '../../lib/pos/api';
import {
  type BillLine,
  billLines,
  durationLabel,
  minutesSince,
  rate,
  sum,
  times,
} from '../../lib/pos/format';
import { enterTarget, searchMenu } from '../../lib/pos/menu-search';
import { useNow } from '../../lib/pos/use-now';
import { printAs } from '../../lib/pos/print';
import { renderBillImage } from '../../lib/print/bill-image';
import { nativePrinter, type NativePrintOutcome } from '../../lib/print/native';
import { nativePrintMessage, printBillNatively } from '../../lib/print/native-bill';
import { useBrand } from '../theme-provider';
import { useActionKey } from '../../lib/use-action-key';
import { loadFloor as loadReservationsFloor } from '../../lib/reservations/host';
import { reservationsVisible, serviceBadges } from '../../lib/reservations/service';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
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
  /** Where it prints (its category's station, ADR 0025). */
  station: PrepStation;
  quantity: number;
  note: string;
}

/**
 * "Send to kitchen", "Send to bar", "Send to kitchen & bar" or "Add to bill", by the stations in
 * the cart that prepare what is sent here (ADR 0031): a station that is off takes nothing.
 */
function sendLabels(
  cart: readonly CartLine[],
  processing: StationProcessing,
): { label: LabelKey; short: LabelKey } {
  const stations = new Set(cart.map((l) => l.station).filter((s) => processing[s]));
  if (stations.size === 0) return { label: 'pos.order.sendCountBill', short: 'pos.order.sendBill' };
  if (stations.size > 1) return { label: 'pos.order.sendCountBoth', short: 'pos.order.sendBoth' };
  if (stations.has('bar')) return { label: 'pos.order.sendCountBar', short: 'pos.order.sendBar' };
  return { label: 'pos.order.sendCount', short: 'pos.order.send' };
}

/**
 * What to print; `seq` grows with every request, so a reprint prints again. A send's tickets (one
 * per station, ADR 0025) print as one print job each, kitchen first, so each can go to its own
 * printer.
 */
type PrintJob =
  | { kind: 'tickets'; tickets: KitchenTicket[]; orderNumber: string; seq: number }
  | { kind: 'bill' | 'slip'; seq: number };

/**
 * Prints #print-root's parts (`data-print-part`) one print job at a time, hiding the others;
 * `window.print()` blocks until each dialog closes.
 */
function printParts(title: string): void {
  const parts = [...document.querySelectorAll<HTMLElement>('#print-root [data-print-part]')];
  if (parts.length <= 1) {
    printAs(title);
    return;
  }
  try {
    for (const part of parts) {
      for (const other of parts) other.hidden = other !== part;
      printAs(title);
    }
  } finally {
    for (const part of parts) part.hidden = false;
  }
}

/** A bill printed by our Android app (ADR 0032): one job id per tap, kept for Retry. */
type NativeBillJob = { jobId: string; outcome: NativePrintOutcome | null };

/**
 * What happened to the bill the app printed: printing, sent, or the failure with Retry (same job id, so a bill
 * that was sent never prints twice) and Print with Android (the print screen).
 */
function NativePrintStatus({
  job,
  onRetry,
  onPrintScreen,
}: {
  job: NativeBillJob | null;
  onRetry: () => void;
  onPrintScreen: () => void;
}) {
  const t = useT();
  if (!job) return null;
  if (!job.outcome) return <Notice text={t('pos.nativePrint.printing')} tone="info" />;
  const failed = job.outcome.state === 'failed';
  return (
    <div data-testid="native-print-status">
      <Notice text={t(nativePrintMessage(job.outcome.code))} tone={failed ? 'error' : 'info'} />
      {failed && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onRetry} data-testid="native-print-retry">
            {t('pos.nativePrint.retry')}
          </Button>
          <Button variant="ghost" onClick={onPrintScreen}>
            {t('pos.nativePrint.printWithAndroid')}
          </Button>
        </div>
      )}
    </div>
  );
}

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
  const { productName } = useBrand();
  const { store, session } = useAuth();
  const action = useActionKey();
  const closeAction = useActionKey();
  const [view, reload] = useResource(tableId, () => loadTableOrder(store, tableId));
  // The bill's header and footer at the table's location (ADR 0025), for those who print bills.
  const locationId = view.status === 'ready' ? view.data.table.locationId : null;
  const [layout] = useResource(access.canPrintBill ? locationId : null, () =>
    loadBillLayout(store, locationId!),
  );
  const now = useNow(30_000);
  const [print, setPrint] = useState<PrintJob | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  // Guests chosen before the table has an order: they go with the first send.
  const [pendingCovers, setPendingCovers] = useState<number | null>(null);
  // A seated booking's party pre-fills them until the waiter changes it (Q7, R1.9; web only).
  const [coversTouched, setCoversTouched] = useState(false);
  const noOrderYet = view.status === 'ready' && view.data.order === null;
  const [bookings] = useResource(
    reservationsVisible(session) && noOrderYet && locationId ? `${locationId}|${tableId}` : null,
    () => loadReservationsFloor(store, locationId!, { kind: 'now' }),
  );
  const seatedParty =
    bookings.status === 'ready'
      ? (serviceBadges(bookings.data).get(tableId)?.seatedParty ?? null)
      : null;
  const covers = coversTouched ? pendingCovers : (pendingCovers ?? seatedParty);
  const choosePending = (next: number | null) => {
    setCoversTouched(true);
    setPendingCovers(next);
  };

  // Inside our Android app (ADR 0032) the bill goes straight to the LAN printer; everything else, and every
  // browser, prints through window.print() as before.
  const [nativeJob, setNativeJob] = useState<NativeBillJob | null>(null);
  const nativeBusy = useRef(false);
  const printNatively = (jobId: string) => {
    const printer = nativePrinter();
    const bill = document.querySelector<HTMLElement>('#print-root [data-testid="printed-bill"]');
    if (!printer || nativeBusy.current) return;
    nativeBusy.current = true;
    setNativeJob({ jobId, outcome: null });
    const done = bill
      ? printBillNatively(printer, bill, jobId, renderBillImage)
      : Promise.resolve<NativePrintOutcome>({ state: 'failed', code: 'print.payload_invalid' });
    void done.then((outcome) => {
      nativeBusy.current = false;
      setNativeJob({ jobId, outcome });
    });
  };
  const printNewBill = useEffectEvent(() => printNatively(crypto.randomUUID()));

  useEffect(() => {
    if (!print) return;
    if (print.kind === 'bill' && nativePrinter()) printNewBill();
    else printParts(organizationName);
  }, [print, organizationName]);
  const nativeStatus = (
    <NativePrintStatus
      job={nativeJob}
      onRetry={() => nativeJob && printNatively(nativeJob.jobId)}
      onPrintScreen={() => printParts(organizationName)}
    />
  );

  /** `sent`: right after a send or void, when items that went straight to the bill don't print. */
  const printTickets = (order: Order, ticketIds: readonly string[], sent = false) => {
    const tickets = order.tickets.filter((x) => ticketIds.includes(x.id) && !(sent && x.direct));
    if (tickets.length > 0) {
      setPrint((prev) => ({
        kind: 'tickets',
        tickets,
        orderNumber: order.number,
        seq: (prev?.seq ?? 0) + 1,
      }));
    }
  };
  const afterWrite = (response: SendTicketResponse) => {
    reload();
    printTickets(response.order, response.ticketIds, true);
  };

  const add = (product: Product, station: PrepStation) => {
    setSent(null);
    setCart((lines) =>
      lines.some((l) => l.product.id === product.id)
        ? lines.map((l) =>
            l.product.id === product.id
              ? { ...l, quantity: Math.min(l.quantity + 1, ORDER_LINE_MAX_QUANTITY) }
              : l,
          )
        : [...lines, { product, station, quantity: 1, note: '' }],
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
      ...(covers === null ? {} : { covers }),
    });
    setBusy(false);
    if (result.ok && result.data) {
      // "Sent: ticket 4 (Kitchen), 5 (Bar)." so it's clear where each went.
      const sequences = result.data.order.tickets
        .filter((x) => result.data?.ticketIds.includes(x.id))
        .map(
          (x) => `${x.sequence} (${t(x.direct ? 'pos.order.toBill' : `pos.station.${x.station}`)})`,
        );
      setCart([]);
      setPendingCovers(null);
      setCoversTouched(false);
      setSent(t('pos.order.sent', { sequence: sequences.join(', ') }));
      afterWrite(result.data);
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <Loaded resource={view} reload={reload}>
      {({ table, order, processing }) => {
        const bill = order ? billLines(order) : [];
        const labels = sendLabels(cart, processing);
        const sendAction =
          cart.length > 0 && access.canTake
            ? {
                label: `${t(labels.label, { count: String(cartCount) })} · ${money(cartTotal)}`,
                short: t(labels.short),
                run: () => void send(),
                testId: 'send-to-kitchen',
                icon:
                  labels.short === 'pos.order.sendBill' ? (
                    <ReceiptText aria-hidden />
                  ) : (
                    <ChefHat aria-hidden />
                  ),
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
              {access.canTake && (
                <Menu tableId={tableId} locationId={table.locationId} cart={cart} onAdd={add} />
              )}
              {/*
                From 1024 px the panel stays in view while the menu scrolls: its own scroll area for
                the cart, the bill and the tickets, with Send and Print pinned below it. Below
                1024 px the bottom bar carries the action.
              */}
              <aside
                id="order-panel"
                className="flex flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)]"
                aria-label={t('pos.order.panel')}
              >
                <div
                  className="flex flex-col gap-4 lg:-mr-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-2"
                  data-testid="order-panel-scroll"
                >
                  {access.canTake && (
                    <GuestsField
                      key={`${order?.id ?? 'new'}:${order?.covers ?? ''}:${seatedParty ?? ''}`}
                      order={order}
                      pending={covers}
                      onPending={choosePending}
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
                        // Below 1024 px; from 1024 px the error shows above the pinned buttons.
                        <div className="lg:hidden">
                          <Notice text={error} tone="error" />
                          {nativeStatus}
                        </div>
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
                  />
                  {order && order.tickets.length > 0 && (
                    <TicketLog
                      order={order}
                      canServe={access.canTake}
                      onReprint={(id) => printTickets(order, [id])}
                      onServed={reload}
                    />
                  )}
                </div>
                {(sendAction || printAction || error) && (
                  <div
                    className="hidden shrink-0 flex-col gap-2 border-t border-border pt-3 lg:flex"
                    data-testid="order-panel-actions"
                  >
                    <Notice text={error} tone="error" />
                    {nativeStatus}
                    {sendAction && (
                      <Button
                        className="min-h-12 gap-2 text-base"
                        disabled={busy}
                        onClick={sendAction.run}
                        data-testid={sendAction.testId}
                      >
                        {sendAction.icon}
                        {sendAction.label}
                      </Button>
                    )}
                    {printAction && (
                      <Button
                        variant={sendAction ? 'outline' : 'default'}
                        className="min-h-11 gap-2"
                        onClick={printAction.run}
                        data-testid={printAction.testId}
                      >
                        {printAction.icon}
                        {printAction.label}
                      </Button>
                    )}
                  </div>
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
                {print.kind === 'tickets' ? (
                  <div key={print.seq}>
                    {print.tickets.map((ticket) => (
                      <div key={ticket.id} data-print-part>
                        <KitchenTicketView
                          organizationName={organizationName}
                          ticket={ticket}
                          tableName={table.name}
                          orderNumber={print.orderNumber}
                        />
                      </div>
                    ))}
                  </div>
                ) : print.kind === 'slip' ? (
                  <OrderSlip
                    key={print.seq}
                    organizationName={organizationName}
                    tableName={table.name}
                    orderNumber={order?.number ?? ''}
                    lines={bill}
                    printedAt={new Date(now)}
                  />
                ) : order ? (
                  <div key={print.seq} data-testid="printed-bill">
                    <Receipt
                      layout={layout.status === 'ready' ? layout.data : null}
                      organizationName={organizationName}
                      productName={productName}
                      tableName={table.name}
                      order={{
                        number: order.number,
                        covers: order.covers,
                        waiterName: order.waiterName,
                        total: order.totals.gross,
                      }}
                      bill={bill}
                      printedAt={new Date(now)}
                    />
                  </div>
                ) : null}
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

/** What the table has: combined items, VAT split, total, and the void action. */
function OnTheTable({
  order,
  bill,
  notice,
  voidButton,
}: {
  order: Order | null;
  bill: BillLine[];
  notice: string | null;
  voidButton: ReactNode;
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
    </Card>
  );
}

function TicketLog({
  order,
  canServe,
  onReprint,
  onServed,
}: {
  order: Order;
  canServe: boolean;
  onReprint: (ticketId: string) => void;
  onServed: () => void;
}) {
  const t = useT();
  const money = useMoney();
  const ready = order.tickets.filter((ticket) => ticket.status === 'ready').length;
  return (
    <details className="rounded-lg border border-border bg-card">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm font-medium">
        {t('pos.bill.tickets', { count: String(order.tickets.length) })}
        {ready > 0 && (
          <Badge className="bg-accent text-accent-foreground" data-testid="till-ready">
            {t('pos.floor.ready', { count: String(ready) })}
          </Badge>
        )}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border p-4">
        {order.tickets.map((ticket) => (
          <section key={ticket.id} className="flex flex-col gap-1" data-testid="order-ticket">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                {t(ticket.kind === 'void' ? 'pos.order.voidTicket' : 'pos.order.ticket', {
                  sequence: String(ticket.sequence),
                })}
                <Badge data-testid="ticket-station">{t(`pos.station.${ticket.station}`)}</Badge>
                {ticket.direct ? (
                  // Straight to the bill: nothing to prepare (ADR 0031).
                  <Badge data-testid="ticket-status" data-status="direct">
                    {t('pos.order.addedToBill')}
                  </Badge>
                ) : (
                  <Badge data-testid="ticket-status" data-status={ticket.status}>
                    {t(`pos.status.${ticket.status}`)}
                  </Badge>
                )}
              </h3>
              <span className="flex gap-1">
                {canServe && ticket.status === 'ready' && (
                  <ServeButton order={order} ticket={ticket} onServed={onServed} />
                )}
                <Button variant="ghost" className="gap-1" onClick={() => onReprint(ticket.id)}>
                  <Printer aria-hidden className="size-4" />
                  {t('pos.order.reprint')}
                </Button>
              </span>
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
  locationId,
  cart,
  onAdd,
}: {
  tableId: string;
  locationId: string;
  cart: CartLine[];
  onAdd: (product: Product, station: PrepStation) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [menu, reloadMenu] = useResource(tableId, async () => {
    const [categories, products] = await Promise.all([loadCategories(store), loadProducts(store)]);
    if (!categories.ok) return categories;
    if (!products.ok) return products;
    return { ok: true as const, data: { categories: categories.data, products: products.data } };
  });
  // What the location charges now (price rules, ADR 0030), checked every minute; the api decides on
  // send. A reload keeps the last answer while it loads, so prices don't flicker.
  const [prices, reloadPrices] = useResource(locationId, () => loadPrices(store, locationId));
  useNow(60_000, reloadPrices);
  const priceOf = new Map<string, EffectivePrice>(
    prices.status === 'ready' ? prices.data.data.map((p) => [p.productId, p]) : [],
  );
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
      {({ categories, products: ownPrices }) => {
        const products = ownPrices.map((p) => ({
          ...p,
          price: priceOf.get(p.id)?.price ?? p.price,
        }));
        const tagOf = (product: Product) => {
          const price = priceOf.get(product.id);
          return price?.timed ? price.ruleName : null;
        };
        const stationOf = new Map(categories.map((c) => [c.id, c.station]));
        const addProduct = (product: Product) =>
          onAdd(product, stationOf.get(product.categoryId) ?? 'kitchen');
        const result = searchMenu(products, query, category);
        return (
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
                  placeholder={t('pos.order.searchNumberHint')}
                  value={query}
                  onChange={(e) => {
                    setAdded(null);
                    setQuery(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    // "12 ⏎ 12 ⏎ 7 ⏎": Enter adds the dish with that number (ADR 0029).
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const target = enterTarget(result);
                    if (!target) return;
                    addProduct(target);
                    setAdded(t('pos.order.added', { name: target.name }));
                    setQuery('');
                  }}
                  data-testid="menu-search"
                />
                <p role="status" className="sr-only" data-testid="menu-added">
                  {added}
                </p>
              </div>
              <ProductGrid
                categories={categories}
                exact={result.exact}
                matching={result.matching}
                category={category}
                inCart={inCart}
                tagOf={tagOf}
                onAdd={addProduct}
              />
            </section>
          </div>
        );
      }}
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
  exact,
  matching,
  category,
  inCart,
  tagOf,
  onAdd,
}: {
  categories: ProductCategory[];
  /** The product whose number was typed: first, above the categories. */
  exact: Product | null;
  matching: Product[];
  category: string | null;
  inCart: ReadonlyMap<string, number>;
  /** A time rule's name for a product priced by one (e.g. "Happy hour"). */
  tagOf: (product: Product) => string | null;
  onAdd: (product: Product) => void;
}) {
  const t = useT();
  // Each category gets a tile colour from the table palette, in category order.
  const colorOf = new Map(
    categories.map((c, i) => [c.id, TABLE_COLORS[(i % (TABLE_COLORS.length - 1)) + 1]!]),
  );
  const groups = categories
    .map((c) => ({ category: c, products: matching.filter((p) => p.categoryId === c.id) }))
    .filter((g) => g.products.length > 0);

  if (groups.length === 0 && !exact)
    return <p className="text-muted-foreground">{t('pos.order.noResults')}</p>;
  return (
    <div className="flex flex-col gap-5">
      {exact && (
        <ul
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
          data-testid="menu-exact"
        >
          <li>
            <ProductCard
              product={exact}
              count={inCart.get(exact.id) ?? 0}
              tag={tagOf(exact)}
              color={colorOf.get(exact.categoryId) ?? TABLE_COLORS[1]}
              onAdd={onAdd}
            />
          </li>
        </ul>
      )}
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
                  tag={tagOf(product)}
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
  tag,
  onAdd,
}: {
  product: Product;
  count: number;
  tag: string | null;
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
      data-number={product.menuNumber ?? undefined}
      onClick={() => onAdd(product)}
    >
      <span
        aria-hidden
        className="flex h-16 items-center justify-center text-2xl font-semibold"
        style={{ backgroundColor: fill, color: stroke }}
      >
        {product.menuNumber ?? product.name.slice(0, 1).toLocaleUpperCase()}
      </span>
      <span className="flex flex-1 flex-col justify-between gap-1 p-3">
        <span className="line-clamp-2 text-sm leading-snug font-medium" title={product.name}>
          {product.name}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
          <span data-testid="menu-price">{money(product.price)}</span>
          {tag && (
            <Badge className="border-primary text-foreground" data-testid="menu-price-tag">
              {tag}
            </Badge>
          )}
        </span>
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

/** A waiter marks a ready ticket as served (ADR 0026); the order reloads either way. */
function ServeButton({
  order,
  ticket,
  onServed,
}: {
  order: Order;
  ticket: KitchenTicket;
  onServed: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      className="gap-1"
      disabled={busy}
      aria-label={t('pos.order.serveTicket', { sequence: String(ticket.sequence) })}
      data-testid="ticket-serve"
      onClick={() => {
        setBusy(true);
        void serveTicket(store, action, order.id, ticket.id).then(() => {
          setBusy(false);
          onServed();
        });
      }}
    >
      <Check aria-hidden className="size-4" />
      {t('pos.order.serve')}
    </Button>
  );
}
