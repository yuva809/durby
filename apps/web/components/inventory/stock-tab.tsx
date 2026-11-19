'use client';

import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadStock } from '../../lib/inventory/api';
import { shortQuantity, sumValues } from '../../lib/inventory/format';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded } from '../users/common';
import { type InventoryData, warehouseLabel } from './inventory-page';
import { useSeesPrices } from './use-sees-prices';

/**
 * What is in stock, per warehouse or for all of them: quantity, average cost, value, low. Without prices (ADR 0060)
 * quantities only.
 */
export function StockTab({ data }: { data: InventoryData }) {
  const t = useT();
  const prices = useSeesPrices();
  const id = useId();
  const money = useMoney();
  const { store } = useAuth();
  const active = data.warehouses.filter((w) => w.archivedAt === null);
  const [warehouseId, setWarehouseId] = useState('');
  const [query, setQuery] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [stock, reload] = useResource(`stock:${warehouseId}`, () =>
    loadStock(store, warehouseId ? { warehouseId } : {}),
  );
  const names = new Map(data.warehouses.map((w) => [w.id, warehouseLabel(data, w)]));

  if (active.length === 0) {
    return <p className="text-muted-foreground">{t('inventory.page.noWarehouses')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid min-w-56 gap-1.5">
          <Label htmlFor={`${id}-warehouse`}>{t('inventory.fields.warehouse')}</Label>
          <Select
            id={`${id}-warehouse`}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            data-testid="stock-warehouse"
          >
            <option value="">{t('inventory.page.allWarehouses')}</option>
            {active.map((w) => (
              <option key={w.id} value={w.id}>
                {names.get(w.id)}
              </option>
            ))}
          </Select>
        </div>
        <div className="relative min-w-56 flex-1">
          <Search
            aria-hidden
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('inventory.page.search')}
            aria-label={t('inventory.page.search')}
          />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox checked={lowOnly} onCheckedChange={(next) => setLowOnly(next === true)} />
          {t('inventory.page.lowOnly')}
        </label>
      </div>
      <Loaded resource={stock} reload={reload}>
        {(levels) => {
          const needle = query.trim().toLowerCase();
          const shown = levels.filter(
            (l) =>
              (!lowOnly || l.low) && (needle === '' || l.itemName.toLowerCase().includes(needle)),
          );
          if (levels.length === 0) {
            return <p className="text-muted-foreground">{t('inventory.page.emptyStock')}</p>;
          }
          return (
            <div className="flex flex-col gap-3">
              {prices && (
                <p className="font-semibold" data-testid="stock-total">
                  {t('inventory.page.totalValue', {
                    value: money(sumValues(shown.map((l) => l.value ?? '0'))),
                  })}
                </p>
              )}
              <Card className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead className="hidden bg-muted text-left text-muted-foreground md:table-header-group">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t('inventory.fields.item')}</th>
                      {!warehouseId && (
                        <th className="px-4 py-2 font-medium">{t('inventory.fields.warehouse')}</th>
                      )}
                      <th className="px-4 py-2 text-right font-medium">
                        {t('inventory.fields.quantity')}
                      </th>
                      {prices && (
                        <th className="px-4 py-2 text-right font-medium">
                          {t('inventory.fields.averageCost')}
                        </th>
                      )}
                      {prices && (
                        <th className="px-4 py-2 text-right font-medium">
                          {t('inventory.fields.value')}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {shown.map((l) => (
                      <tr
                        key={`${l.warehouseId}:${l.itemId}`}
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 md:table-row md:p-0"
                        data-testid="stock-row"
                        data-name={l.itemName}
                      >
                        <td className="w-full font-medium md:w-auto md:px-4 md:py-2">
                          <span className="flex items-center gap-2">
                            {l.itemName}
                            {l.low && (
                              <Badge
                                className="bg-accent text-accent-foreground"
                                data-testid="stock-low"
                              >
                                {t('inventory.page.low')}
                              </Badge>
                            )}
                          </span>
                        </td>
                        {!warehouseId && (
                          <td className="w-full text-muted-foreground md:w-auto md:px-4 md:py-2">
                            {names.get(l.warehouseId)}
                          </td>
                        )}
                        <td
                          className={cn(
                            'tabular-nums md:px-4 md:py-2 md:text-right',
                            l.quantity.startsWith('-') && 'text-destructive',
                          )}
                          data-testid="stock-quantity"
                        >
                          {`${shortQuantity(l.quantity)} ${t(`inventory.units.${l.unit}`)}`}
                        </td>
                        {prices && l.averageCost !== null && (
                          <td className="text-muted-foreground tabular-nums md:px-4 md:py-2 md:text-right">
                            {money(l.averageCost)}
                          </td>
                        )}
                        {prices && l.value !== null && (
                          <td className="ml-auto font-medium tabular-nums md:px-4 md:py-2 md:text-right">
                            {money(l.value)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          );
        }}
      </Loaded>
    </div>
  );
}
