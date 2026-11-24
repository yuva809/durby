'use client';

import { formatPackSize, STOCK_REQUEST_NOTE_MAX_LENGTH } from '@durby/shared';
import { CheckCircle2, ShoppingCart, Truck } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { beyondStock, cartReady, cartUnits, requestLines } from '../../lib/orders/request-cart';
import { createRequest } from '../../lib/orders/requests-api';
import { useActionKey } from '../../lib/use-action-key';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet';
import { AvailableText, CartControl } from './cart-controls';
import { useRequestCart } from './request-cart-context';

/**
 * The request cart on Inventory (ADR 0065): "Request Cart" with how many items are in it, opening the cart beside the
 * page (not another page): each line with what the warehouse has, − / + and its unit, a note, then Send Request. The
 * person stays on Inventory; "View my stock requests" leads to Order History for who wants it.
 */
export function RequestCartSheet() {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const shop = useRequestCart();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  if (!shop) return null;
  const { lines, units, setCart, setUnit } = shop;
  const route = shop.route.status === 'ready' ? shop.route.data : null;
  const count = lines.length;

  async function send() {
    if (!route) return;
    if (!cartReady(lines)) {
      setError(t('orders.requestForm.quantityInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await createRequest(store, action, {
      ...(route.branch.warehouseId
        ? { toWarehouseId: route.branch.warehouseId }
        : { toLocationId: route.branch.locationId }),
      lines: requestLines(lines),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(t(errorLabel(result.ok ? 'unknown' : result.code)));
      return;
    }
    action.done();
    setCart(() => ({}));
    setNote('');
    setSent(result.data.number);
    shop?.reloadOffered();
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setSent(null);
          setError(null);
          setOpen(true);
        }}
        data-testid="inventory-request-stock"
      >
        <ShoppingCart aria-hidden />
        {t('inventory.overview.requestStock')}
        {count > 0 && (
          <span
            className="ml-1 flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground"
            data-testid="request-cart-badge"
          >
            {count}
          </span>
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          closeLabel={t('platform.common.close')}
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
          data-testid="request-cart"
        >
          <div className="flex flex-col gap-1 border-b p-5 pr-14">
            <SheetTitle className="not-sr-only text-xl font-semibold">
              {t('platform.nav.requestStock')}
            </SheetTitle>
            <SheetDescription className="not-sr-only text-sm text-muted-foreground">
              {route
                ? t('orders.requestCart.route', {
                    from: route.source.name,
                    to: route.branch.locationName,
                  })
                : t('orders.requestForm.noWarehouse')}
            </SheetDescription>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            {sent && (
              <div
                className="flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3"
                role="status"
                data-testid="request-sent"
              >
                <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="flex flex-col gap-0.5">
                  <p className="font-semibold">
                    {t('orders.requestCart.sentTitle', { number: sent })}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t('orders.requestCart.sentHint')}
                  </p>
                </div>
              </div>
            )}
            {count === 0 ? (
              !sent && (
                <div
                  className="flex flex-col items-center gap-2 py-10 text-center"
                  data-testid="request-cart-empty"
                >
                  <ShoppingCart aria-hidden className="size-8 text-muted-foreground" />
                  <p className="font-medium">{t('orders.requestCart.emptyTitle')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('orders.requestCart.emptyCart')}
                  </p>
                </div>
              )
            ) : (
              <>
                <ul className="flex flex-col divide-y">
                  {lines.map(({ item, quantity }) => {
                    const pack = formatPackSize({
                      count: item.packCount,
                      size: item.packSize,
                      unit: item.packUnit,
                    });
                    return (
                      <li
                        key={item.itemId}
                        className="flex items-center gap-3 py-3"
                        data-testid="request-cart-line"
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium" title={item.itemName}>
                            {item.itemName}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {[pack, t(`inventory.units.${item.unit}`)].filter(Boolean).join(' · ')}
                          </span>
                          <AvailableText
                            item={item}
                            quantity={quantity}
                            testId="request-cart-available"
                          />
                        </div>
                        <CartControl
                          item={item}
                          quantity={quantity}
                          onChange={setCart}
                          unit={units[item.itemId]}
                          onUnit={(unit) => setUnit(item.itemId, unit)}
                        />
                      </li>
                    );
                  })}
                </ul>
                {route && route.branch.keepsStock && !route.branch.warehouseId && (
                  <p className="text-sm text-muted-foreground">
                    {t('orders.requestCart.newStore', { branch: route.branch.locationName })}
                  </p>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-note`}>{t('orders.requestForm.note')}</Label>
                  <textarea
                    id={`${id}-note`}
                    value={note}
                    rows={2}
                    maxLength={STOCK_REQUEST_NOTE_MAX_LENGTH}
                    placeholder={t('orders.requestCart.notePlaceholder')}
                    onChange={(e) => setNote(e.target.value)}
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    data-testid="request-note"
                  />
                </div>
                {beyondStock(lines).length > 0 && (
                  <p className="text-sm text-muted-foreground" data-testid="request-cart-beyond">
                    {t('orders.requestCart.beyondHint')}
                  </p>
                )}
              </>
            )}
            <Notice text={error} tone="error" />
          </div>

          <div className="flex flex-col gap-2 border-t p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground" data-testid="request-cart-count">
                {t('orders.requestCart.itemCount', { count: String(count) })}
              </span>
              <span className="font-semibold" data-testid="request-cart-units">
                {t('orders.requestCart.unitCount', { count: cartUnits(lines, units) })}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={count === 0 || busy}
                onClick={() => setCart(() => ({}))}
                data-testid="request-clear"
              >
                {t('orders.requestCart.clear')}
              </Button>
              <Button
                className="flex-1"
                disabled={busy || count === 0 || !route}
                onClick={() => void send()}
                data-testid="request-submit"
              >
                <Truck aria-hidden />
                {t('orders.requestCart.sendShort')}
              </Button>
            </div>
            <Link
              href="/requests"
              className="self-center text-sm text-primary underline-offset-4 hover:underline"
              data-testid="request-cart-history"
            >
              {t('orders.requestCart.myRequests')}
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
