'use client';

import {
  type KitchenTicket,
  type Order,
  ORDER_LINE_MAX_QUANTITY,
  ORDER_NOTE_MAX_LENGTH,
  type Product,
  type ProductCategory,
  type SendTicketResponse,
} from '@durby/shared';
import { Minus, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories, loadProducts } from '../../lib/catalog/api';
import { closeOrder, loadTableOrder, sendTicket, voidLines } from '../../lib/pos/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { KitchenTicketView, PrintRoot } from './kitchen-ticket';

interface Access {
  canTake: boolean;
  canVoid: boolean;
  canClose: boolean;
}

/** /pos/order/[tableId]: take a table's order and send it to the kitchen (docs/modules/pos.md). */
export function OrderPage({ tableId }: { tableId: string }) {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('pos.orders.read')) return <NoAccess title="pos.nav.title" />;
  return (
    <TableOrder
      tableId={tableId}
      access={{
        canTake: permissions.has('pos.orders.take'),
        canVoid: permissions.has('pos.orders.void'),
        canClose: permissions.has('pos.orders.close'),
      }}
    />
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

function TableOrder({ tableId, access }: { tableId: string; access: Access }) {
  const t = useT();
  const { store } = useAuth();
  const [view, reload] = useResource(tableId, () => loadTableOrder(store, tableId));
  const [print, setPrint] = useState<PrintJob | null>(null);

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

  return (
    <Loaded resource={view} reload={reload}>
      {({ table, order }) => (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-1">
              <Link href="/pos" className="text-sm">
                {t('pos.order.back')}
              </Link>
              <h1 className="text-2xl font-semibold">
                {t('pos.order.title', { table: table.name })}
              </h1>
            </div>
            {order && <Badge>{t('pos.order.current', { number: order.number })}</Badge>}
          </div>
          <div className={cn('grid gap-6', access.canTake && 'lg:grid-cols-[1fr_24rem]')}>
            {access.canTake && <Menu tableId={tableId} onSent={afterWrite} />}
            <div className="flex flex-col gap-4">
              {order ? (
                <OrderView
                  order={order}
                  access={access}
                  onReprint={(ticketId) => printTicket(order, ticketId)}
                  onVoided={afterWrite}
                  onClosed={reload}
                />
              ) : (
                <p className="text-muted-foreground">{t('pos.order.noOrder')}</p>
              )}
            </div>
          </div>
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

/** Categories, products and the cart; Send to kitchen posts the cart as one ticket. */
function Menu({
  tableId,
  onSent,
}: {
  tableId: string;
  onSent: (response: SendTicketResponse) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [menu, reloadMenu] = useResource(tableId, async () => {
    const [categories, products] = await Promise.all([loadCategories(store), loadProducts(store)]);
    if (!categories.ok) return categories;
    if (!products.ok) return products;
    return { ok: true as const, data: { categories: categories.data, products: products.data } };
  });
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = (product: Product) =>
    setCart((lines) =>
      lines.some((l) => l.product.id === product.id)
        ? lines.map((l) =>
            l.product.id === product.id
              ? { ...l, quantity: Math.min(l.quantity + 1, ORDER_LINE_MAX_QUANTITY) }
              : l,
          )
        : [...lines, { product, quantity: 1, note: '' }],
    );
  const change = (productId: string, patch: Partial<CartLine>) =>
    setCart((lines) =>
      lines
        .map((l) => (l.product.id === productId ? { ...l, ...patch } : l))
        .filter((l) => l.quantity > 0),
    );

  async function send() {
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
      setCart([]);
      onSent(result.data);
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">{t('pos.order.menu')}</h2>
      <Loaded resource={menu} reload={reloadMenu}>
        {({ categories, products }) => (
          <MenuGrid
            categories={categories}
            products={products}
            category={category}
            onCategory={setCategory}
            onAdd={add}
          />
        )}
      </Loaded>
      <Card className="flex flex-col gap-3 p-4" aria-label={t('pos.order.cart')}>
        <h2 className="text-lg font-medium">{t('pos.order.cart')}</h2>
        {cart.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pos.order.cartEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {cart.map((line) => (
              <CartRow key={line.product.id} line={line} onChange={change} />
            ))}
          </ul>
        )}
        <Notice text={error} tone="error" />
        <Button
          disabled={cart.length === 0 || busy}
          onClick={() => void send()}
          data-testid="send-to-kitchen"
        >
          {t('pos.order.send')}
        </Button>
      </Card>
    </div>
  );
}

function MenuGrid({
  categories,
  products,
  category,
  onCategory,
  onAdd,
}: {
  categories: ProductCategory[];
  products: Product[];
  category: string | null;
  onCategory: (id: string | null) => void;
  onAdd: (product: Product) => void;
}) {
  const t = useT();
  const shown = products.filter((p) => category === null || p.categoryId === category);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={category === null ? 'default' : 'outline'}
          aria-pressed={category === null}
          onClick={() => onCategory(null)}
        >
          {t('catalog.page.allCategories')}
        </Button>
        {categories.map((c) => (
          <Button
            key={c.id}
            variant={category === c.id ? 'default' : 'outline'}
            aria-pressed={category === c.id}
            onClick={() => onCategory(c.id)}
          >
            {c.name}
          </Button>
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((product) => (
          <li key={product.id}>
            <Button
              variant="outline"
              className="flex h-auto min-h-16 w-full flex-col items-start gap-1 whitespace-normal p-3 text-left"
              data-testid="menu-product"
              onClick={() => onAdd(product)}
            >
              <span className="font-medium">{product.name}</span>
              <span className="text-sm text-muted-foreground tabular-nums">{product.price}</span>
            </Button>
          </li>
        ))}
      </ul>
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
  const id = useId();
  const name = line.product.name;
  return (
    <li className="flex flex-col gap-2" data-testid="cart-line" data-name={name}>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label={t('pos.order.decrease', { name })}
          onClick={() => onChange(line.product.id, { quantity: line.quantity - 1 })}
        >
          <Minus aria-hidden />
        </Button>
        <span className="w-8 text-center tabular-nums" data-testid="cart-quantity">
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
        <span className="font-medium">{name}</span>
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
    </li>
  );
}

/** The order so far: tickets with their lines, totals and the order actions. */
function OrderView({
  order,
  access,
  onReprint,
  onVoided,
  onClosed,
}: {
  order: Order;
  access: Access;
  onReprint: (ticketId: string) => void;
  onVoided: (response: SendTicketResponse) => void;
  onClosed: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const closeAction = useActionKey();
  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="order-view">
      {order.tickets.map((ticket) => (
        <section key={ticket.id} className="flex flex-col gap-2" data-testid="order-ticket">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">
              {t(ticket.kind === 'void' ? 'pos.order.voidTicket' : 'pos.order.ticket', {
                sequence: String(ticket.sequence),
              })}
            </h3>
            <Button variant="ghost" onClick={() => onReprint(ticket.id)}>
              {t('pos.order.reprint')}
            </Button>
          </div>
          <ul className="flex flex-col gap-1 text-sm">
            {ticket.lines.map((line) => (
              <li
                key={line.id}
                className={cn(
                  'flex justify-between gap-2',
                  line.quantity > 0 && line.remaining === 0 && 'text-muted-foreground line-through',
                )}
              >
                <span>
                  {t('pos.order.lineQuantity', {
                    quantity: String(line.quantity),
                    name: line.productName,
                  })}
                  {line.note && <span className="block text-muted-foreground">{line.note}</span>}
                </span>
                <span className="tabular-nums">{line.total}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <p className="flex justify-between font-semibold">
          <span>
            {t('pos.order.total')} ·{' '}
            {t('pos.order.itemCount', { count: String(order.totals.itemCount) })}
          </span>
          <span className="tabular-nums" data-testid="order-total">
            {order.totals.gross}
          </span>
        </p>
        {order.totals.byTaxRate.map((rate) => (
          <p key={rate.taxRate} className="text-sm text-muted-foreground">
            {t('pos.order.vatLine', { rate: rate.taxRate, net: rate.net, tax: rate.tax })}
          </p>
        ))}
      </div>
      {order.status === 'open' && (access.canVoid || access.canClose) && (
        <div className="flex flex-wrap gap-2">
          {access.canVoid && order.totals.itemCount > 0 && (
            <VoidDialog order={order} onVoided={onVoided} />
          )}
          {access.canClose && (
            <ConfirmAction
              testId="close-order"
              trigger={t('pos.order.close')}
              title={t('pos.order.closeTitle', { number: order.number })}
              description={t('pos.order.closeDescription')}
              confirm={t('pos.order.close')}
              run={() => closeOrder(store, closeAction, order.id)}
              onDone={onClosed}
            />
          )}
        </div>
      )}
    </Card>
  );
}

/** Choose how many of each sent item to void; prints the VOID ticket. */
function VoidDialog({
  order,
  onVoided,
}: {
  order: Order;
  onVoided: (response: SendTicketResponse) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const lines = order.tickets.flatMap((ticket) => ticket.lines.filter((l) => l.remaining > 0));
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <FormDialog
      trigger={t('pos.order.void')}
      triggerVariant="outline"
      testId="void-items"
      title={t('pos.order.voidTitle')}
      onOpen={() => {
        setCounts({});
        setProblem(null);
      }}
      submit={() => {
        const chosen = lines
          .map((line) => ({ lineId: line.id, quantity: Number(counts[line.id] ?? '0') }))
          .filter((l) => l.quantity > 0);
        const invalid = lines.some((line) => {
          const n = Number(counts[line.id] ?? '0');
          return !Number.isInteger(n) || n < 0 || n > line.remaining;
        });
        if (chosen.length === 0 || invalid) {
          setProblem(t('pos.order.voidNothing'));
          return null;
        }
        setProblem(null);
        return voidLines(store, action, order.id, { lines: chosen }).then((result) => {
          if (result.ok && result.data) onVoided(result.data);
          return result;
        });
      }}
      onDone={() => undefined}
    >
      <p className="text-sm text-muted-foreground">{t('pos.order.voidDescription')}</p>
      {lines.map((line) => (
        <Field
          key={line.id}
          id={`${id}-${line.id}`}
          label={t('pos.order.lineQuantity', {
            quantity: String(line.remaining),
            name: line.productName,
          })}
          problem={null}
        >
          <Input
            id={`${id}-${line.id}`}
            inputMode="numeric"
            aria-label={t('pos.order.voidQuantity', { name: line.productName })}
            value={counts[line.id] ?? ''}
            onChange={(e) => setCounts((c) => ({ ...c, [line.id]: e.target.value }))}
          />
        </Field>
      ))}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </FormDialog>
  );
}
