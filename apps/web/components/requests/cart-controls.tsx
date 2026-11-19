'use client';

import type { RequestAvailability } from '@durby/shared';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../../app/labels-provider';
import {
  availableText,
  boxesOf,
  canAddMore,
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
 * Adding an item to the request cart (ADR 0053, 0065): "Add", then − / quantity / +, never beyond what the warehouse
 * has. An item that comes in boxes (pieces with a pack count) is ordered by the box or by the piece: by the box the
 * quantity is boxes and "= 24 pc" says what that is; the cart keeps pieces either way.
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
  return (
    <div className="flex flex-col items-end gap-1">
      {perBox !== null && (
        <div
          className="flex rounded-md border p-0.5 text-xs"
          role="group"
          aria-label={t('orders.requestCart.orderBy', { name: item.itemName })}
        >
          {(['box', 'piece'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={(value === 'box') === byBox}
              onClick={() => onUnit(value)}
              className={cn(
                'min-h-8 rounded px-2 font-medium',
                (value === 'box') === byBox
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted',
              )}
              data-testid={`request-unit-${value}`}
            >
              {value === 'box'
                ? t('orders.requestCart.box', { count: String(perBox) })
                : t('inventory.units.pc')}
            </button>
          ))}
        </div>
      )}
      {quantity === undefined ? (
        <Button
          className="h-9"
          variant="outline"
          // Nothing (or not a whole box) there, nothing to ask for.
          disabled={!canAddMore(undefined, item.available, step)}
          onClick={() => onChange((cart) => increment(cart, item.itemId, item.available, step))}
          aria-label={t('orders.requestCart.addName', { name: item.itemName })}
          data-testid="request-add"
        >
          <Plus aria-hidden />
          {t('orders.requestCart.add')}
        </Button>
      ) : (
        <Stepper
          item={item}
          quantity={quantity}
          onChange={onChange}
          perBox={byBox ? perBox : null}
        />
      )}
      {byBox && quantity !== undefined && validQuantity(quantity) && (
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
  return (
    <div className="flex items-center gap-1" data-testid="request-stepper">
      <Button
        size="icon"
        variant="outline"
        className="size-9"
        onClick={() => {
          setDraft(null);
          onChange((cart) => decrement(cart, item.itemId, step));
        }}
        aria-label={t('orders.requestCart.less', { name: item.itemName })}
        data-testid="request-less"
      >
        <Minus aria-hidden />
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
        aria-invalid={
          !validQuantity(quantity) || !withinStock(quantity, item.available) || undefined
        }
        className="h-9 w-16 text-center"
        data-testid="request-quantity"
      />
      <Button
        size="icon"
        variant="outline"
        className="size-9"
        // Not beyond what the warehouse has.
        disabled={!canAddMore(quantity, item.available, step)}
        onClick={() => {
          setDraft(null);
          onChange((cart) => increment(cart, item.itemId, item.available, step));
        }}
        aria-label={t('orders.requestCart.more', { name: item.itemName })}
        data-testid="request-more"
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}

/**
 * What the warehouse has for a line; red with "Only 2 pc available" when more is asked for, which blocks sending.
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
  const beyond =
    quantity !== undefined && quantity.trim() !== '' && !withinStock(quantity, item.available);
  return (
    <span
      className={cn('text-sm', beyond ? 'font-medium text-destructive' : 'text-muted-foreground')}
      data-testid={testId}
    >
      {beyond
        ? t('orders.requestCart.onlyAvailable', values)
        : t('orders.requestCart.available', values)}
    </span>
  );
}
