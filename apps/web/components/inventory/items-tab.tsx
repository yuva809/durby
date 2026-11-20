'use client';

import {
  priceSchema,
  type ProductCategory,
  STOCK_UNITS,
  type StockItem,
  type StockUnit,
  type Warehouse,
} from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createStockItem, loadStock, postReceipt, updateStockItem } from '../../lib/inventory/api';
import { isQuantity, shortQuantity } from '../../lib/inventory/format';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { LocationFilter, stockQueryOf } from './location-filter';
import type { InventoryData } from './inventory-page';

/** Stock items: name, article number, unit and reorder level; managed with inventory.items.edit. */
export function ItemsTab({ data }: { data: InventoryData }) {
  const t = useT();
  const { store } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
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
  const shown = data.items.filter(
    (i) => (showArchived || i.archivedAt === null) && (here === null || here.has(i.id)),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
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
            locations={data.locations}
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
                  {item.name}
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
                  <ItemDialog item={item} categories={data.categories} onDone={data.reload} />
                  <ArchiveButton item={item} onDone={data.reload} />
                </span>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
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
  locations,
}: {
  item?: StockItem;
  categories: readonly ProductCategory[] | null;
  onDone: () => void;
  trigger?: string;
  /** Pre-filled for a new item, e.g. the category open on the inventory page. */
  defaultCategoryId?: string | null;
  /** New items only: the warehouse that gets the opening stock (stock is kept per warehouse). */
  warehouses?: readonly Warehouse[];
  /** New items only: the branches to choose the opening stock's warehouse from. */
  locations?: InventoryData['locations'];
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
  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [opening, setOpening] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [checked, setChecked] = useState(false);
  const receiptAction = useActionKey();
  const activeWarehouses = (warehouses ?? []).filter((w) => w.archivedAt === null);
  // The warehouses that serve a branch: the main one, its own store, and any that supplies it (ADR 0067).
  const warehousesFor = (branch: string) =>
    activeWarehouses.filter(
      (w) => w.isMain || w.locationId === branch || w.suppliesLocationIds.includes(branch),
    );
  const openingInvalid = checked && opening.trim() !== '' && !isQuantity(opening.trim());
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
      trigger={trigger ?? t(item ? 'inventory.page.edit' : 'inventory.page.addItem')}
      triggerVariant={item ? 'outline' : 'default'}
      testId={item ? 'item-edit' : 'item-create'}
      title={t(item ? 'inventory.page.editItem' : 'inventory.page.addItem')}
      onOpen={() => {
        setName(item?.name ?? '');
        setSku(item?.sku ?? '');
        setUnit(item?.unit ?? 'kg');
        setMin(item?.minQuantity ? shortQuantity(item.minQuantity) : '');
        setSalePrice(item?.salePrice ?? '');
        setCategoryId(item ? (item.categoryId ?? '') : (defaultCategoryId ?? ''));
        // The main warehouse by default, else the first active one.
        const startBranch =
          activeWarehouses.find((w) => w.isMain)?.locationId ?? locations?.[0]?.id ?? '';
        setBranchId(startBranch);
        setWarehouseId(warehousesFor(startBranch)[0]?.id ?? '');
        setOpening('');
        setUnitCost('');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '' || (min.trim() !== '' && !isQuantity(min))) return null;
        if (salePrice.trim() !== '' && !priceSchema.safeParse(salePrice.trim()).success)
          return null;
        if (item) {
          return updateStockItem(store, action, item.id, {
            name: name.trim(),
            sku: sku.trim() || null,
            unit,
            minQuantity: min.trim() || null,
            ...(sells ? { salePrice: salePrice.trim() || null } : {}),
            ...(categories ? { categoryId: categoryId || null } : {}),
          });
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
          >
            {STOCK_UNITS.map((u) => (
              <option key={u} value={u}>
                {t(`inventory.units.${u}`)}
              </option>
            ))}
          </Select>
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
      {!item && activeWarehouses.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('inventory.page.pricingStock')}
          </p>
          <Field id={`${id}-branch`} label={t('inventory.fields.location')} problem={null}>
            <Select
              id={`${id}-branch`}
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value);
                setWarehouseId(warehousesFor(e.target.value)[0]?.id ?? '');
              }}
              data-testid="item-branch"
            >
              {(locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${id}-warehouse`} label={t('inventory.fields.warehouse')} problem={null}>
            <Select
              id={`${id}-warehouse`}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              data-testid="item-warehouse"
            >
              {warehousesFor(branchId).map((w) => (
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
    </FormDialog>
  );
}
