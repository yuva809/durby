'use client';

import { formatPackSize, type RequestAvailability } from '@durby/shared';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { availableText, type Cart } from '../../lib/orders/request-cart';
import { ExpiryDate } from '../inventory/expiry-date';
import { Card } from '../ui/card';
import { Loaded } from '../users/common';
import { CartControl } from './cart-controls';
import { useRequestCart } from './request-cart-context';

/**
 * A category's items as a branch sees them (ADR 0065): brand, product, pack size, what the supplying warehouse has,
 * unit, its earliest best-before and "Request", which puts the item in the page's request cart (by the box or the
 * piece); the header's Request Cart counts and sends it.
 */
export function BranchShop({ itemIds }: { itemIds: readonly string[] }) {
  const t = useT();
  const shop = useRequestCart();
  if (!shop) return null;
  const { route, offered, cart, setCart, units, setUnit } = shop;
  const wanted = new Set(itemIds);
  const head =
    'px-3 py-2 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase';
  return (
    <Loaded resource={route} reload={() => undefined}>
      {(where) =>
        where === null ? (
          <Notice text={t('orders.requestForm.noWarehouse')} tone="info" />
        ) : (
          <Loaded resource={offered} reload={shop.reloadOffered}>
            {(items) => (
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
                      <th className={`${head} text-right`}>{t('orders.requestCart.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {items
                      .filter((i) => wanted.has(i.itemId))
                      .map((item) => (
                        <Row
                          key={item.itemId}
                          item={item}
                          quantity={cart[item.itemId]}
                          onChange={setCart}
                          unit={units[item.itemId]}
                          onUnit={(unit) => setUnit(item.itemId, unit)}
                        />
                      ))}
                  </tbody>
                </table>
              </Card>
            )}
          </Loaded>
        )
      }
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
  const out = Number(item.available) <= 0;
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
      <td className="px-3 py-2 text-right tabular-nums">
        <span className="inline-flex items-center gap-2">
          <span data-testid="branch-shop-available">{availableText(item.available)}</span>
          {out && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
              {t('orders.requestCart.out')}
            </span>
          )}
        </span>
      </td>
      <td className="px-3 py-2">{t(`inventory.units.${item.unit}`)}</td>
      <td className="px-3 py-2">
        <ExpiryDate value={item.expiresOn} />
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end">
          <CartControl
            item={item}
            quantity={quantity}
            onChange={onChange}
            unit={unit}
            onUnit={onUnit}
          />
        </div>
      </td>
    </tr>
  );
}
