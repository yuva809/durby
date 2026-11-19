'use client';

import type { RequestAvailability } from '@durby/shared';
import { ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { formatPackSize } from '../../lib/inventory/pack-size';
import {
  availableText,
  type Cart,
  cartStorageKey,
  parseStoredCart,
  unitsStorageKey,
} from '../../lib/orders/request-cart';
import {
  loadAvailability,
  loadRequestDestinations,
  loadRequestWarehouses,
} from '../../lib/orders/requests-api';
import { useResource } from '../../lib/use-resource';
import { ExpiryDate } from '../inventory/expiry-date';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Loaded } from '../users/common';
import { CartControl, useCartUnits } from './cart-controls';

/**
 * A category's items as a branch sees them (ADR 0065): brand, product, pack size, what the main warehouse has, unit,
 * its earliest best-before and the request cart, by the box or the piece. The cart is the request cart's own
 * (kept in the browser per branch): "Open cart" sends it.
 */
export function BranchShop({ itemIds }: { itemIds: readonly string[] }) {
  const t = useT();
  const { store, session } = useAuth();
  const organizationId = session?.activeOrganizationId ?? null;
  const [warehouses] = useResource(organizationId, () => loadRequestWarehouses(store));
  const [destinations] = useResource(organizationId, () => loadRequestDestinations(store));
  return (
    <Loaded resource={warehouses} reload={() => undefined}>
      {(sources) => (
        <Loaded resource={destinations} reload={() => undefined}>
          {(branches) => {
            const branch = branches[0];
            // The warehouse supplying the branch (ADR 0067), else the main one.
            const main =
              sources.find((w) => w.id === branch?.supplierWarehouseId) ??
              sources.find((w) => w.isMain);
            if (!main || !branch || !organizationId) {
              return <Notice text={t('orders.requestForm.noWarehouse')} tone="info" />;
            }
            return (
              <Shop
                organizationId={organizationId}
                warehouseId={main.id}
                locationId={branch.locationId}
                itemIds={itemIds}
              />
            );
          }}
        </Loaded>
      )}
    </Loaded>
  );
}

function Shop({
  organizationId,
  warehouseId,
  locationId,
  itemIds,
}: {
  organizationId: string;
  warehouseId: string;
  locationId: string;
  itemIds: readonly string[];
}) {
  const t = useT();
  const { store } = useAuth();
  const [offered] = useResource(`${organizationId}:${warehouseId}`, () =>
    loadAvailability(store, warehouseId),
  );
  const key = cartStorageKey(organizationId, locationId);
  const [cart, setCart] = useState<Cart>(() => readCart(key));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(cart));
    } catch {
      // Private mode or blocked storage: the cart lives only on this page.
    }
  }, [key, cart]);
  const [units, setUnit] = useCartUnits(unitsStorageKey(organizationId, locationId));
  const wanted = new Set(itemIds);
  const count = Object.keys(cart).length;
  const head =
    'px-3 py-2 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase';

  return (
    <Loaded resource={offered} reload={() => undefined}>
      {(items) => {
        const rows = items.filter((i) => wanted.has(i.itemId));
        return (
          <div className="flex flex-col gap-3">
            <Card className="overflow-x-auto p-0">
              <table className="w-full min-w-[56rem] text-sm" data-testid="branch-shop">
                <thead className="bg-muted">
                  <tr>
                    <th className={head}>{t('inventory.invoice.brand')}</th>
                    <th className={head}>{t('inventory.fields.item')}</th>
                    <th className={head}>{t('inventory.invoice.packSize')}</th>
                    <th className={`${head} text-right`}>{t('inventory.fields.quantity')}</th>
                    <th className={head}>{t('inventory.fields.unit')}</th>
                    <th className={head}>{t('inventory.fields.expiresOn')}</th>
                    <th className={`${head} text-right`}>{t('orders.requestCart.title')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((item) => (
                    <Row
                      key={item.itemId}
                      item={item}
                      quantity={cart[item.itemId]}
                      onChange={(next) => setCart((c) => next(c))}
                      unit={units[item.itemId]}
                      onUnit={(unit) => setUnit(item.itemId, unit)}
                    />
                  ))}
                </tbody>
              </table>
            </Card>
            {count > 0 && (
              <div className="sticky bottom-3 z-30 flex items-center justify-between gap-3 rounded-xl border bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
                <span
                  className="flex items-center gap-2 font-medium"
                  data-testid="branch-shop-count"
                >
                  <ShoppingCart aria-hidden className="size-5 text-primary" />
                  {t('orders.requestCart.bar', { count: String(count) })}
                </span>
                <Button asChild>
                  <Link href="/requests/new?cart=1" data-testid="branch-shop-open">
                    {t('orders.requestCart.view')}
                  </Link>
                </Button>
              </div>
            )}
          </div>
        );
      }}
    </Loaded>
  );
}

function Row({
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
  const pack = formatPackSize({ count: item.packCount, size: item.packSize, unit: item.packUnit });
  return (
    <tr className="align-middle" data-testid="branch-shop-row" data-name={item.itemName}>
      <td className="px-3 py-2 text-muted-foreground">{item.brand ?? '–'}</td>
      <td className="px-3 py-2 font-medium">
        {item.itemName}
        {item.sku && <span className="block text-xs text-muted-foreground">{item.sku}</span>}
      </td>
      <td className="px-3 py-2" data-testid="branch-shop-pack">
        {pack || '–'}
      </td>
      <td className="px-3 py-2 text-right tabular-nums" data-testid="branch-shop-available">
        {availableText(item.available)}
      </td>
      <td className="px-3 py-2">{t(`inventory.units.${item.unit}`)}</td>
      <td className="px-3 py-2">
        <ExpiryDate value={item.expiresOn} />
      </td>
      <td className="px-3 py-2">
        <CartControl
          item={item}
          quantity={quantity}
          onChange={onChange}
          unit={unit}
          onUnit={onUnit}
        />
      </td>
    </tr>
  );
}

function readCart(key: string): Cart {
  try {
    return parseStoredCart(localStorage.getItem(key));
  } catch {
    return {};
  }
}
