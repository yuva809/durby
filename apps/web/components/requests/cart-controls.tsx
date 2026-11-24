'use client';

import type { RequestAvailability } from '@durby/shared';
import { Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../../app/labels-provider';
import {
  availableText,
  boxesOf,
  type Cart,
  type CartUnits,
  decrement,
  increment,
  parseStoredUnits,
  piecesOf,
  piecesPerBox,
  setQuantity,
  validQuantity,
  withinStock,
} from '../../lib/orders/request-cart';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

type Change = (next: (cart: Cart) => Cart) => void;

/** Box or piece per item, kept in the browser beside the cart (ADR 0065). */
export function useCartUnits(
  key: string,
): [CartUnits, (itemId: string, unit: 'box' | 'piece') => void] {
  const [units, setUnits] = useState<CartUnits>(() => readUnits(key));
  const [unitsKey, setUnitsKey] = useState(key);
  if (unitsKey !== key) {
    setUnitsKey(key);
    setUnits(readUnits(key));
  }
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(units));
    } catch {
      // Private mode or blocked storage: the choice lives only on this page.
    }
  }, [key, units]);
  return [units, (itemId, unit) => setUnits((u) => ({ ...u, [itemId]: unit }))];
}

function readUnits(key: string): CartUnits {
  try {
    return parseStoredUnits(localStorage.getItem(key));
  } catch {
    return {};
  }
}

/**
 * Adding an item to the request cart (ADR 0053, 0065): "Request", then remove (at one) or − / quantity / + and the unit
 * it is ordered in. More than the warehouse has may be asked for: it is sent once it is in (the cart says so). An item
 * that comes in boxes (pieces with a pack count) is ordered by the box or by the piece: by the box the quantity is
 * boxes and "= 24 pc" says what that is; the cart keeps pieces either way.
 */
export function CartControl({
  item,
  quantity,
  onChange,
  unit,
  onUnit,
}: {
  item: RequestAvailability;
  quantity: string | undefined;
  onChange: Change;
  unit: 'box' | 'piece' | undefined;
  onUnit: (unit: 'box' | 'piece') => void;
}) {
  const t = useT();
  const perBox = piecesPerBox(item);
  const byBox = perBox !== null && unit !== 'piece';
  const step = byBox ? perBox : 1;
  if (quantity === undefined) {
    return (
      <Button
        className="h-9"
        variant="outline"
        onClick={() => onChange((cart) => increment(cart, item.itemId, undefined, step))}
        aria-label={t('orders.requestCart.addName', { name: item.itemName })}
        data-testid="request-add"
      >
        <ShoppingCart aria-hidden />
        {t('orders.requestCart.add')}
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5" data-testid="request-stepper">
        <Stepper
          item={item}
          quantity={quantity}
          onChange={onChange}
          perBox={byBox ? perBox : null}
        />
        {perBox !== null ? (
          <select
            value={byBox ? 'box' : 'piece'}
            onChange={(e) => onUnit(e.target.value as 'box' | 'piece')}
            aria-label={t('orders.requestCart.orderBy', { name: item.itemName })}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            data-testid="request-unit"
          >
            <option value="box">{t('orders.requestCart.box', { count: String(perBox) })}</option>
            <option value="piece">{t('inventory.units.pc')}</option>
          </select>
        ) : (
          <span
            className="flex h-9 min-w-14 items-center rounded-md border px-2 text-sm text-muted-foreground"
            data-testid="request-unit-fixed"
          >
            {t(`inventory.units.${item.unit}`)}
          </span>
        )}
      </div>
      {byBox && validQuantity(quantity) && (
        <span className="text-xs text-muted-foreground" data-testid="request-pieces">
          {t('orders.requestCart.pieces', { count: quantity.trim().replace(',', '.') })}
        </span>
      )}
    </div>
  );
}

function Stepper({
  item,
  quantity,
  onChange,
  perBox,
}: {
  item: RequestAvailability;
  quantity: string;
  onChange: Change;
  /** By the box: the input shows boxes. */
  perBox: number | null;
}) {
  const t = useT();
  // By the box, what is being typed until it is a quantity (the cart keeps pieces).
  const [draft, setDraft] = useState<string | null>(null);
  const step = perBox ?? 1;
  const shown = draft ?? (perBox ? boxesOf(quantity, perBox) : quantity);
  // At one (box or piece) the next step down takes the item out: a bin, not a minus.
  const last = Number(quantity.trim().replace(',', '.')) <= step;
  return (
    <>
      <Button
        size="icon"
        variant="outline"
        className="size-9 rounded-full"
        onClick={() => {
          setDraft(null);
          onChange((cart) => decrement(cart, item.itemId, step));
        }}
        aria-label={t(last ? 'orders.requestCart.remove' : 'orders.requestCart.less', {
          name: item.itemName,
        })}
        data-testid="request-less"
      >
        {last ? <Trash2 aria-hidden /> : <Minus aria-hidden />}
      </Button>
      <Input
        inputMode="decimal"
        value={shown}
        onChange={(e) => {
          const value = e.target.value;
          if (!perBox) {
            onChange((cart) => setQuantity(cart, item.itemId, value));
            return;
          }
          setDraft(value);
          const pieces = piecesOf(value.replace(',', '.'), perBox);
          if (pieces !== null) onChange((cart) => setQuantity(cart, item.itemId, pieces));
        }}
        onBlur={() => setDraft(null)}
        aria-label={t('orders.requestForm.quantity', { name: item.itemName })}
        aria-invalid={!validQuantity(quantity) || undefined}
        className="h-9 w-16 text-center"
        data-testid="request-quantity"
      />
      <Button
        size="icon"
        variant="outline"
        className="size-9 rounded-full"
        onClick={() => {
          setDraft(null);
          onChange((cart) => increment(cart, item.itemId, undefined, step));
        }}
        aria-label={t('orders.requestCart.more', { name: item.itemName })}
        data-testid="request-more"
      >
        <Plus aria-hidden />
      </Button>
    </>
  );
}

/**
 * What the warehouse has for a line: "120 Box available at the warehouse"; red when it has none or less than asked
 * (still sent: approval and packing decide).
 */
export function AvailableText({
  item,
  quantity,
  testId,
}: {
  item: RequestAvailability;
  quantity: string | undefined;
  testId?: string;
}) {
  const t = useT();
  const values = {
    quantity: availableText(item.available),
    unit: t(`inventory.units.${item.unit}`),
  };
  const none = Number(item.available) <= 0;
  const beyond =
    quantity !== undefined && quantity.trim() !== '' && !withinStock(quantity, item.available);
  return (
    <span
      className={cn(
        'text-sm',
        none || beyond ? 'font-medium text-destructive' : 'text-muted-foreground',
      )}
      data-testid={testId}
    >
      {none
        ? t('orders.requestCart.noneAvailable')
        : beyond
          ? t('orders.requestCart.onlyAvailable', values)
          : t('orders.requestCart.available', values)}
    </span>
  );
}
