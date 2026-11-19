'use client';

import {
  INVENTORY_NOTE_MAX_LENGTH,
  type Bom,
  type LocationSummary,
  type Warehouse,
} from '@durby/shared';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import {
  loadBoms,
  loadDocuments,
  loadStock,
  loadWarehouses,
  postProduction,
} from '../../lib/inventory/api';
import {
  compareQuantities,
  isQuantity,
  scaledQuantity,
  shortQuantity,
} from '../../lib/inventory/format';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded } from '../users/common';
import { InventorySubPage } from './sub-page';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

/** What making `wanted` of a bill takes, with what the warehouse has: the preview of a production order. */
export function productionNeeds(
  bom: Bom,
  wanted: string,
  onHand: ReadonlyMap<string, string>,
): {
  itemId: string;
  itemName: string;
  unit: Bom['unit'];
  needed: string;
  onHand: string;
  short: boolean;
}[] {
  return bom.lines.map((line) => {
    const needed = scaledQuantity(line.quantity, wanted, bom.outputQuantity) ?? '0.000';
    const have = onHand.get(line.itemId) ?? '0.000';
    return {
      itemId: line.itemId,
      itemName: line.itemName,
      unit: line.unit,
      needed,
      onHand: have,
      short: compareQuantities(have, needed) < 0,
    };
  });
}

/** Inventory → Production Order (ADR 0038): make a prepared item from its bill of materials in one warehouse. */
export function ProductionPage() {
  return (
    <InventorySubPage
      title="inventory.nav.production"
      description="inventory.production.description"
    >
      {({ organizationId, can }) => (
        <Production organizationId={organizationId} canProduce={can('inventory.stock.produce')} />
      )}
    </InventorySubPage>
  );
}

function Production({
  organizationId,
  canProduce,
}: {
  organizationId: string | null;
  canProduce: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [warehouses, reloadWarehouses] = useResource(organizationId, () => loadWarehouses(store));
  const [boms, reloadBoms] = useResource(organizationId, () => loadBoms(store));
  const [locations] = useResource(organizationId, () => loadLocations(store));
  const reload = () => {
    reloadWarehouses();
    reloadBoms();
  };
  return (
    <Loaded resource={warehouses} reload={reload}>
      {(warehouseList) => (
        <Loaded resource={boms} reload={reload}>
          {(bomList) =>
            warehouseList.length === 0 ? (
              <p className="text-muted-foreground">{t('inventory.page.noWarehouses')}</p>
            ) : bomList.length === 0 ? (
              <p className="text-muted-foreground">{t('inventory.production.noBoms')}</p>
            ) : (
              <ProductionForm
                organizationId={organizationId}
                warehouses={warehouseList}
                locations={locations.status === 'ready' ? locations.data : []}
                boms={bomList}
                canProduce={canProduce}
              />
            )
          }
        </Loaded>
      )}
    </Loaded>
  );
}

function ProductionForm({
  organizationId,
  warehouses,
  locations,
  boms,
  canProduce,
}: {
  organizationId: string | null;
  warehouses: Warehouse[];
  locations: LocationSummary[];
  boms: Bom[];
  canProduce: boolean;
}) {
  const t = useT();
  const id = useId();
  const money = useMoney();
  const { store } = useAuth();
  const action = useActionKey();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]!.id);
  const [itemId, setItemId] = useState(boms[0]!.itemId);
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);
  const key = organizationId === null ? null : `${organizationId}:${warehouseId}`;
  const [stock, reloadStock] = useResource(key, () => loadStock(store, { warehouseId }));
  const [documents, reloadDocuments] = useResource(key, () =>
    loadDocuments(store, { warehouseId, kind: 'production' }),
  );
  const bom = boms.find((b) => b.itemId === itemId) ?? boms[0]!;
  const onHand = new Map(
    stock.status === 'ready' ? stock.data.map((l) => [l.itemId, l.quantity] as const) : [],
  );
  const valid = isQuantity(quantity);
  const needs = valid ? productionNeeds(bom, quantity.trim(), onHand) : [];
  const label = (w: Warehouse) => {
    if (locations.length < 2) return w.name;
    const location = locations.find((l) => l.id === w.locationId);
    return location ? `${location.name} · ${w.name}` : w.name;
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    setPosted(null);
    if (!valid) return;
    setBusy(true);
    setError(null);
    const result = await postProduction(store, action, {
      warehouseId,
      itemId: bom.itemId,
      quantity: quantity.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (result.ok && result.data) {
      setPosted(t('inventory.page.posted', { number: result.data.number }));
      setQuantity('');
      setNote('');
      setChecked(false);
      reloadStock();
      reloadDocuments();
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)} noValidate>
        <Card className="grid gap-4 p-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-warehouse`}>{t('inventory.fields.warehouse')}</Label>
            <Select
              id={`${id}-warehouse`}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              data-testid="production-warehouse"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {label(w)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-item`}>{t('inventory.production.item')}</Label>
            <Select
              id={`${id}-item`}
              value={bom.itemId}
              onChange={(e) => setItemId(e.target.value)}
              data-testid="production-item"
            >
              {boms.map((b) => (
                <option key={b.itemId} value={b.itemId}>
                  {b.itemName}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-quantity`}>
              {t('inventory.fields.quantity')} ({t(`inventory.units.${bom.unit}`)})
            </Label>
            <Input
              id={`${id}-quantity`}
              inputMode="decimal"
              value={quantity}
              aria-invalid={(checked && !valid) || undefined}
              aria-describedby={`${id}-quantity-hint`}
              className={cn('tabular-nums', checked && !valid && 'border-destructive')}
              onChange={(e) => {
                setPosted(null);
                setQuantity(e.target.value.replace(',', '.'));
              }}
              data-testid="production-quantity"
            />
            <p id={`${id}-quantity-hint`} className="text-xs text-muted-foreground">
              {checked && !valid
                ? t('inventory.page.quantityInvalid')
                : t('inventory.boms.makes', {
                    quantity: shortQuantity(bom.outputQuantity),
                    unit: t(`inventory.units.${bom.unit}`),
                  })}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-note`}>{t('inventory.fields.note')}</Label>
            <Input
              id={`${id}-note`}
              value={note}
              maxLength={INVENTORY_NOTE_MAX_LENGTH}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </Card>

        <Card className="flex flex-col p-0">
          <h2 className="border-b px-4 py-3 text-sm font-medium">
            {t('inventory.production.components')}
          </h2>
          {needs.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {t('inventory.production.enterQuantity')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      {t('inventory.fields.item')}
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      {t('inventory.production.needed')}
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      {t('inventory.production.onHand')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {needs.map((need) => (
                    <tr key={need.itemId} data-testid="production-need" data-short={need.short}>
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-2">
                          {need.itemName}
                          {need.short && (
                            <Badge className="bg-destructive text-destructive-foreground">
                              {t('inventory.production.short')}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {shortQuantity(need.needed)} {t(`inventory.units.${need.unit}`)}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-2 text-right tabular-nums',
                          need.short ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {shortQuantity(need.onHand)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            className="min-h-11"
            disabled={busy || !canProduce}
            data-testid="production-post"
          >
            {t('inventory.production.post')}
          </Button>
          <Notice text={error} tone="error" />
          <Notice text={posted} tone="info" />
        </div>
      </form>

      <section className="flex flex-col gap-2" aria-labelledby={`${id}-recent`}>
        <h2 id={`${id}-recent`} className="text-lg font-medium">
          {t('inventory.production.recent')}
        </h2>
        <Loaded resource={documents} reload={reloadDocuments}>
          {(list) =>
            list.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('inventory.production.noOrders')}</p>
            ) : (
              <Card className="divide-y p-0">
                {list.slice(0, 20).map((doc) => (
                  <div
                    key={doc.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
                    data-testid="production-order"
                  >
                    <span className="flex flex-col">
                      <span className="font-medium tabular-nums">{doc.number}</span>
                      <span className="text-muted-foreground">
                        {dateFormat.format(new Date(doc.createdAt))}
                      </span>
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {t('inventory.production.lines', { count: String(doc.lineCount) })}
                      {doc.note ? ` · ${doc.note}` : ''}
                      {doc.value !== null && ` · ${money(doc.value)}`}
                    </span>
                  </div>
                ))}
              </Card>
            )
          }
        </Loaded>
      </section>
    </div>
  );
}
