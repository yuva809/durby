'use client';

import {
  priceSchema,
  type ProductCategory,
  STOCK_UNITS,
  type StockItem,
  type StockUnit,
  unitChangeAllowed,
  unitCostSchema,
  type Warehouse,
} from '@durby/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  createStockItem,
  deleteStockItem,
  loadStock,
  postAdjustment,
  postReceipt,
  updateStockItem,
} from '../../lib/inventory/api';
import { isQuantity, shortQuantity } from '../../lib/inventory/format';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Field, FormDialog } from '../form-dialog';
import { ConfirmAction } from '../users/common';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { LocationFilter, stockQueryOf } from './location-filter';
import type { InventoryData } from './inventory-page';

/** Why stock changes while editing an item: received (a receipt at a cost), or an adjustment's reason. */
type StockReason = 'purchase' | 'correction' | 'count' | 'waste' | 'breakage' | 'other';

/** a − b, exact to thousandths ("122" − "120" → "2", "4.5" − "5" → "-0.5"). */
function difference(a: string, b: string): string {
  const milli = (v: string) => {
    const [whole = '0', fraction = ''] = v.replace(',', '.').replace('-', '').split('.');
    const value = BigInt(whole || '0') * 1000n + BigInt((fraction + '000').slice(0, 3));
    return v.trim().startsWith('-') ? -value : value;
  };
  const d = milli(a) - milli(b);
  const sign = d < 0n ? '-' : '';
  const abs = d < 0n ? -d : d;
  const fraction = String(abs % 1000n)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${sign}${abs / 1000n}${fraction ? `.${fraction}` : ''}`;
}

/** Stock items: name, article number, unit and reorder level; managed with inventory.items.edit. */
export function ItemsTab({ data }: { data: InventoryData }) {
  const t = useT();
  const { store } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
  // The search: starts with ?q= from the top bar, then what is typed here.
  const [query, setQuery] = useState(useSearchParams().get('q') ?? '');
  // Each word typed must appear in the name or SKU, in any order.
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  // A warehouse filter shows only the items it holds, with its own quantity (stock is kept per warehouse).
  // The filter: "w:<warehouse>" for one warehouse, "l:<branch>" for a branch's warehouse, "" for all locations.
  const [filter, setFilter] = useState('');
  const [levels] = useResource(filter ? `items-stock:${filter}` : null, () =>
    loadStock(store, stockQueryOf(filter)),
  );
  const here =
    filter && levels.status === 'ready'
      ? new Map(levels.data.map((l) => [l.itemId, l.quantity]))
      : null;
  // Where each item is held, in every warehouse (shown on each card).
  const [allLevels] = useResource('items-stock:all', () => loadStock(store, {}));
  const warehouseName = (id: string) => data.warehouses.find((w) => w.id === id)?.name ?? '';
  const heldIn = (itemId: string) =>
    allLevels.status === 'ready'
      ? allLevels.data.filter((l) => l.itemId === itemId && l.quantity !== '0')
      : [];
  const canManage = data.can('inventory.items.edit');
  const canDelete = data.can('inventory.items.delete');
  const shown = data.items.filter(
    (i) =>
      (showArchived || i.archivedAt === null) &&
      (here === null || here.has(i.id)) &&
      words.every(
        (w) => i.name.toLowerCase().includes(w) || (i.sku ?? '').toLowerCase().includes(w),
      ),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('inventory.page.searchItems')}
          aria-label={t('inventory.page.searchItems')}
          className="min-w-60 flex-1"
          data-testid="items-search"
        />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(next) => setShowArchived(next === true)}
          />
          {t('inventory.page.showArchived')}
        </label>
        <LocationFilter
          id="items-location"
          value={filter}
          data={data}
          onChange={setFilter}
          testId="items-warehouse"
        />
        {canManage && (
          <ItemDialog
            categories={data.categories}
            warehouses={data.warehouses}
            onDone={data.reload}
          />
        )}
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground">{t('inventory.page.noItems')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="item-grid">
          {shown.map((item) => (
            <Card
              key={item.id}
              className="flex flex-col justify-between gap-4 p-4"
              data-testid="item-row"
              data-name={item.name}
            >
              <div className="flex flex-col gap-2">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  <Link
                    href={`/inventory/items/${item.id}`}
                    className="underline-offset-4 hover:underline"
                    data-testid="item-link"
                  >
                    {item.name}
                  </Link>
                  {item.archivedAt && <Badge>{t('inventory.page.archived')}</Badge>}
                </span>
                <span className="text-sm text-muted-foreground">
                  {[
                    t(`inventory.units.${item.unit}`),
                    item.sku,
                    item.minQuantity &&
                      `${t('inventory.fields.minQuantity')}: ${shortQuantity(item.minQuantity)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {here ? (
                  <span className="text-sm tabular-nums" data-testid="item-here">
                    {shortQuantity(here.get(item.id) ?? '0')} {t(`inventory.units.${item.unit}`)}
                  </span>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm" data-testid="item-warehouses">
                    {heldIn(item.id).length === 0 ? (
                      <li className="text-muted-foreground">{t('inventory.page.notInStock')}</li>
                    ) : (
                      heldIn(item.id).map((l) => (
                        <li key={l.warehouseId} data-testid="item-warehouse-row">
                          {warehouseName(l.warehouseId)}: {shortQuantity(l.quantity)}{' '}
                          {t(`inventory.units.${item.unit}`)}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
              {canManage && (
                <span className="flex gap-2">
                  <ItemDialog
                    item={item}
                    categories={data.categories}
                    warehouses={data.warehouses}
                    held={allLevels.status === 'ready' ? heldIn(item.id) : undefined}
                    onDone={data.reload}
                  />
                  <ArchiveButton item={item} onDone={data.reload} />
                  {canDelete && <DeleteItemButton item={item} onDone={data.reload} />}
                </span>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/** Deletes an item with no stock history; asks first. An item with history is archived instead (ADR 0027). */
function DeleteItemButton({ item, onDone }: { item: StockItem; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <ConfirmAction
      testId="item-delete"
      trigger={t('inventory.page.deleteItem')}
      title={t('inventory.page.deleteItemTitle', { name: item.name })}
      description={t('inventory.page.deleteItemDescription')}
      confirm={t('inventory.page.deleteItem')}
      run={() => deleteStockItem(store, action, item.id)}
      onDone={onDone}
    />
  );
}

function ArchiveButton({ item, onDone }: { item: StockItem; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [busy, setBusy] = useState(false);
  const archived = item.archivedAt !== null;
  return (
    <Button
      variant="outline"
      disabled={busy}
      data-testid={archived ? 'item-restore' : 'item-archive'}
      onClick={() => {
        setBusy(true);
        void updateStockItem(store, action, item.id, { archived: !archived }).then(() => {
          setBusy(false);
          onDone();
        });
      }}
    >
      {t(archived ? 'inventory.page.restore' : 'inventory.page.archive')}
    </Button>
  );
}

/**
 * Create (no `item`) or edit a stock item. `categories`: the organization's, to file it under one (ADR 0048); null
 * hides the field. `trigger`: the button's text when it isn't the default (e.g. "Add New Item").
 */
export function ItemDialog({
  item,
  categories,
  onDone,
  trigger,
  defaultCategoryId,
  warehouses,
  held,
  mode = 'edit',
}: {
  item?: StockItem;
  categories: readonly ProductCategory[] | null;
  onDone: () => void;
  trigger?: string;
  /** Pre-filled for a new item, e.g. the category open on the inventory page. */
  defaultCategoryId?: string | null;
  /**
   * The warehouse that gets a new item's opening stock, or an edited item's added stock (stock is kept per
   * warehouse).
   */
  warehouses?: readonly Warehouse[];
  /** An edited item's stock per warehouse, to show what is there before adding. */
  held?: readonly { warehouseId: string; quantity: string }[];
  /**
   * `stock`: only the stock quantity of `item` (Adjust stock in the inventory list): no item fields, nothing but the
   * difference is booked, for anyone who may receive or adjust stock.
   */
  mode?: 'edit' | 'stock';
}) {
  const t = useT();
  const id = useId();
  const { store, session } = useAuth();
  const action = useActionKey();
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [unit, setUnit] = useState<StockUnit>('kg');
  const [min, setMin] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [opening, setOpening] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [checked, setChecked] = useState(false);
  const receiptAction = useActionKey();
  const stockOnly = mode === 'stock' && item !== undefined;
  // Without `held` the item's stock is read when the dialog opens.
  const [fetched, setFetched] = useState<{ warehouseId: string; quantity: string }[] | null>(null);
  const levels = held ?? fetched ?? undefined;
  // Editing: the stock quantity in a warehouse, set to what is counted. The difference is booked: more as received
  // goods at a cost (a receipt) or found stock (an adjustment at the average cost); less as an adjustment. Each
  // reason only for who may book it.
  const permissions = session?.activePermissions ?? [];
  const receives = permissions.includes('inventory.stock.receive');
  const adjusts = permissions.includes('inventory.stock.adjust');
  // Stock somewhere: the item has moved, so its unit only relabels between counted units.
  const stocked = (levels ?? []).length > 0;
  const onHand = (warehouse: string) =>
    shortQuantity(levels?.find((l) => l.warehouseId === warehouse)?.quantity ?? '0');
  const target = opening.trim().replace(',', '.');
  const change =
    item && target !== '' && isQuantity(target) ? difference(target, onHand(warehouseId)) : '0';
  const up = Number(change) > 0;
  const reasons: StockReason[] = up
    ? [
        ...(receives ? (['purchase'] as const) : []),
        ...(adjusts ? (['correction', 'count', 'other'] as const) : []),
      ]
    : adjusts
      ? ['correction', 'count', 'waste', 'breakage', 'other']
      : [];
  const [chosenReason, setReason] = useState<StockReason>('purchase');
  const reason = reasons.includes(chosenReason) ? chosenReason : (reasons[0] ?? 'correction');
  const [remarks, setRemarks] = useState('');
  const changing = item !== undefined && Number(change) !== 0;
  const costInvalid =
    checked &&
    changing &&
    reason === 'purchase' &&
    !unitCostSchema.safeParse(unitCost.trim().replace(',', '.')).success;
  const activeWarehouses = (warehouses ?? []).filter((w) => w.archivedAt === null);
  const openingInvalid = checked && opening.trim() !== '' && !isQuantity(opening.trim());
  // Adjust stock with nothing changed: say so rather than closing.
  const unchanged = stockOnly && checked && !changing && !openingInvalid;
  // Active categories to choose from, plus the item's own even if archived meanwhile (it stays until changed).
  const choices = (categories ?? []).filter(
    (c) => c.archivedAt === null || c.id === item?.categoryId,
  );
  const parentName = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const choiceLabel = (c: ProductCategory) =>
    c.parentId ? `${parentName.get(c.parentId) ?? ''} › ${c.name}` : c.name;
  // The default price on sales orders (ADR 0044): only where the organization has orders, and only for those who see
  // prices (ADR 0060); otherwise it is neither shown nor sent, so it stays as it is.
  const sells =
    (session?.activeFeatures.includes('orders') ?? false) &&
    (session?.activePermissions.includes('inventory.prices.read') ?? false);
  const priceInvalid =
    checked && salePrice.trim() !== '' && !priceSchema.safeParse(salePrice.trim()).success;
  const nameMissing = checked && name.trim() === '';
  const minInvalid = checked && min.trim() !== '' && !isQuantity(min);

  return (
    <FormDialog
      trigger={
        trigger ??
        t(
          stockOnly
            ? 'inventory.adjust.open'
            : item
              ? 'inventory.page.edit'
              : 'inventory.page.addItem',
        )
      }
      triggerVariant={item ? 'outline' : 'default'}
      testId={stockOnly ? 'item-adjust' : item ? 'item-edit' : 'item-create'}
      title={
        stockOnly
          ? t('inventory.adjust.title', { name: item.name })
          : t(item ? 'inventory.page.editItem' : 'inventory.page.addItem')
      }
      onOpen={() => {
        setName(item?.name ?? '');
        setSku(item?.sku ?? '');
        setUnit(item?.unit ?? 'kg');
        setMin(item?.minQuantity ? shortQuantity(item.minQuantity) : '');
        setSalePrice(item?.salePrice ?? '');
        setCategoryId(item ? (item.categoryId ?? '') : (defaultCategoryId ?? ''));
        // The main warehouse by default, else the first active one.
        const first = (activeWarehouses.find((w) => w.isMain) ?? activeWarehouses[0])?.id ?? '';
        setWarehouseId(first);
        // Editing: the quantity there now, to change; a new item: its opening stock, empty.
        setOpening(item && first ? onHand(first) : '');
        if (item && !held) {
          setFetched(null);
          void loadStock(store, {}).then((result) => {
            if (!result.ok) return;
            const mine = result.data
              .filter((l) => l.itemId === item.id)
              .map((l) => ({ warehouseId: l.warehouseId, quantity: l.quantity }));
            setFetched(mine);
            setOpening(shortQuantity(mine.find((l) => l.warehouseId === first)?.quantity ?? '0'));
          });
        }
        setUnitCost('');
        setReason('purchase');
        setRemarks('');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (stockOnly && (!changing || reasons.length === 0 || warehouseId === '')) return null;
        if (name.trim() === '' || (min.trim() !== '' && !isQuantity(min))) return null;
        if (salePrice.trim() !== '' && !priceSchema.safeParse(salePrice.trim()).success)
          return null;
        if (item) {
          if (target !== '' && !isQuantity(target)) return null;
          // A changed quantity nobody here may book is not dropped silently.
          if (changing && reasons.length === 0) return null;
          const adding = changing && reasons.length > 0 && warehouseId !== '';
          if (
            adding &&
            reason === 'purchase' &&
            !unitCostSchema.safeParse(unitCost.trim().replace(',', '.')).success
          ) {
            return null;
          }
          return (async () => {
            // Adjust stock: the item stays as it is.
            const updated = stockOnly
              ? ({ ok: true, data: item } as const)
              : await updateStockItem(store, action, item.id, {
                  name: name.trim(),
                  sku: sku.trim() || null,
                  unit,
                  minQuantity: min.trim() || null,
                  ...(sells ? { salePrice: salePrice.trim() || null } : {}),
                  ...(categories ? { categoryId: categoryId || null } : {}),
                });
            if (!updated.ok || !adding) return updated;
            const note = remarks.trim() ? { note: remarks.trim().slice(0, 500) } : {};
            // Received goods carry their cost; found stock comes in at the item's average cost.
            const stock =
              reason === 'purchase'
                ? await postReceipt(store, receiptAction, {
                    warehouseId,
                    ...note,
                    lines: [
                      {
                        itemId: item.id,
                        quantity: change,
                        unitCost: unitCost.trim().replace(',', '.'),
                      },
                    ],
                  })
                : await postAdjustment(store, receiptAction, {
                    warehouseId,
                    reason,
                    ...note,
                    lines: [{ itemId: item.id, quantity: change }],
                  });
            return stock.ok ? updated : stock;
          })();
        }
        const openingQty = opening.trim();
        if (openingQty !== '' && (!isQuantity(openingQty) || warehouseId === '')) return null;
        return (async () => {
          const created = await createStockItem(store, action, {
            name: name.trim(),
            unit,
            ...(sku.trim() ? { sku: sku.trim() } : {}),
            ...(min.trim() ? { minQuantity: min.trim() } : {}),
            ...(sells && salePrice.trim() ? { salePrice: salePrice.trim() } : {}),
            ...(categories && categoryId ? { categoryId } : {}),
          });
          // Opening stock goes into the chosen warehouse only, as a receipt.
          if (!created.ok || !created.data || openingQty === '' || Number(openingQty) <= 0) {
            return created;
          }
          const receipt = await postReceipt(store, receiptAction, {
            warehouseId,
            lines: [
              { itemId: created.data.id, quantity: openingQty, unitCost: unitCost.trim() || '0' },
            ],
          });
          return receipt.ok ? created : receipt;
        })();
      }}
      onDone={onDone}
    >
      {!stockOnly && (
        <>
          <Field
            id={`${id}-name`}
            label={t('inventory.fields.name')}
            problem={nameMissing ? t('inventory.page.nameRequired') : null}
          >
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={100}
              aria-invalid={nameMissing || undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {categories && (
            <Field id={`${id}-category`} label={t('inventory.fields.category')} problem={null}>
              <Select
                id={`${id}-category`}
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                data-testid="item-category"
              >
                <option value="">{t('inventory.page.uncategorized')}</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {choiceLabel(c)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${id}-unit`} label={t('inventory.fields.unit')} problem={null}>
              <Select
                id={`${id}-unit`}
                value={unit}
                onChange={(e) => setUnit(e.target.value as StockUnit)}
                data-testid="item-unit"
              >
                {/* With stock, only the units it may change to (counted ones relabel; weight stays). */}
                {STOCK_UNITS.filter((u) => !item || unitChangeAllowed(item.unit, u, stocked)).map(
                  (u) => (
                    <option key={u} value={u}>
                      {t(`inventory.units.${u}`)}
                    </option>
                  ),
                )}
              </Select>
              {item && stocked && unit !== item.unit && (
                <span className="text-xs text-muted-foreground" data-testid="item-unit-relabel">
                  {t('inventory.addStock.unitRelabel', {
                    quantity: onHand(warehouseId),
                    from: t(`inventory.units.${item.unit}`),
                    to: t(`inventory.units.${unit}`),
                  })}
                </span>
              )}
            </Field>
            <Field
              id={`${id}-min`}
              label={t('inventory.fields.minQuantity')}
              problem={minInvalid ? t('inventory.page.quantityInvalid') : null}
            >
              <Input
                id={`${id}-min`}
                inputMode="decimal"
                value={min}
                aria-invalid={minInvalid || undefined}
                onChange={(e) => setMin(e.target.value.replace(',', '.'))}
              />
            </Field>
          </div>
          <Field id={`${id}-sku`} label={t('inventory.fields.sku')} problem={null}>
            <Input
              id={`${id}-sku`}
              value={sku}
              maxLength={50}
              onChange={(e) => setSku(e.target.value)}
            />
          </Field>
          {sells && (
            <Field
              id={`${id}-sale-price`}
              label={t('inventory.fields.salePrice')}
              problem={priceInvalid ? t('inventory.page.salePriceInvalid') : null}
            >
              <Input
                id={`${id}-sale-price`}
                inputMode="decimal"
                value={salePrice}
                aria-invalid={priceInvalid || undefined}
                onChange={(e) => setSalePrice(e.target.value.replace(',', '.'))}
                data-testid="item-sale-price"
              />
            </Field>
          )}
        </>
      )}
      {!item && activeWarehouses.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('inventory.page.pricingStock')}
          </p>
          <Field id={`${id}-warehouse`} label={t('inventory.fields.warehouse')} problem={null}>
            <Select
              id={`${id}-warehouse`}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              data-testid="item-warehouse"
            >
              {activeWarehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.isMain ? `${w.name} (${t('inventory.page.mainWarehouse')})` : w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id={`${id}-opening`}
            label={t('inventory.fields.openingStock')}
            problem={openingInvalid ? t('inventory.page.quantityInvalid') : null}
          >
            <Input
              id={`${id}-opening`}
              inputMode="decimal"
              value={opening}
              aria-invalid={openingInvalid || undefined}
              onChange={(e) => setOpening(e.target.value)}
              data-testid="item-opening"
            />
          </Field>
          <Field id={`${id}-cost`} label={t('inventory.fields.unitCost')} problem={null}>
            <Input
              id={`${id}-cost`}
              inputMode="decimal"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              data-testid="item-unit-cost"
            />
          </Field>
        </>
      )}
      {item && activeWarehouses.length > 0 && (receives || adjusts) && (
        <section className="flex flex-col gap-4 border-t pt-4" data-testid="item-add-stock">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t('inventory.page.pricingStock')}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${id}-add`}
              label={t('inventory.addStock.quantity', { unit: t(`inventory.units.${unit}`) })}
              problem={
                openingInvalid
                  ? t('inventory.page.quantityInvalid')
                  : unchanged
                    ? t('inventory.adjust.unchanged')
                    : null
              }
            >
              <Input
                id={`${id}-add`}
                inputMode="decimal"
                value={opening}
                aria-invalid={openingInvalid || undefined}
                onChange={(e) => setOpening(e.target.value.replace(',', '.'))}
                data-testid="item-add-quantity"
              />
            </Field>
            <Field id={`${id}-warehouse`} label={t('inventory.fields.warehouse')} problem={null}>
              <Select
                id={`${id}-warehouse`}
                value={warehouseId}
                onChange={(e) => {
                  // Another warehouse: what it has, to change.
                  setWarehouseId(e.target.value);
                  setOpening(onHand(e.target.value));
                }}
                data-testid="item-add-warehouse"
              >
                {activeWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground" data-testid="item-add-on-hand">
            {changing
              ? t(up ? 'inventory.addStock.changeUp' : 'inventory.addStock.changeDown', {
                  quantity: change.replace('-', ''),
                  unit: t(`inventory.units.${unit}`),
                  onHand: onHand(warehouseId),
                })
              : t('inventory.addStock.onHand', {
                  quantity: onHand(warehouseId),
                  unit: t(`inventory.units.${unit}`),
                  name: activeWarehouses.find((w) => w.id === warehouseId)?.name ?? '',
                })}
          </p>
          {changing && reasons.length === 0 && (
            <p className="text-sm text-destructive" data-testid="item-add-not-allowed">
              {t('inventory.addStock.notAllowed')}
            </p>
          )}
          {changing && reasons.length > 0 && (
            <>
              <Field id={`${id}-reason`} label={t('inventory.addStock.reason')} problem={null}>
                <Select
                  id={`${id}-reason`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value as StockReason)}
                  data-testid="item-add-reason"
                >
                  {reasons.map((r) => (
                    <option key={r} value={r}>
                      {t(`inventory.addStock.reasons.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              {reason === 'purchase' ? (
                <Field
                  id={`${id}-add-cost`}
                  label={t('inventory.fields.unitCost')}
                  problem={costInvalid ? t('inventory.addStock.costInvalid') : null}
                >
                  <Input
                    id={`${id}-add-cost`}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={unitCost}
                    aria-invalid={costInvalid || undefined}
                    onChange={(e) => setUnitCost(e.target.value)}
                    data-testid="item-add-cost"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t('inventory.addStock.costHint')}
                  </span>
                </Field>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="item-add-average">
                  {t(up ? 'inventory.addStock.averageHint' : 'inventory.addStock.outHint')}
                </p>
              )}
              <Field id={`${id}-remarks`} label={t('inventory.addStock.remarks')} problem={null}>
                <Input
                  id={`${id}-remarks`}
                  value={remarks}
                  maxLength={500}
                  placeholder={t('inventory.addStock.remarksPlaceholder')}
                  onChange={(e) => setRemarks(e.target.value)}
                  data-testid="item-add-remarks"
                />
              </Field>
            </>
          )}
        </section>
      )}
    </FormDialog>
  );
}
