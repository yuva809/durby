'use client';

import {
  priceSchema,
  type ProductCategory,
  STOCK_UNITS,
  type StockItem,
  type StockUnit,
} from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createStockItem, updateStockItem } from '../../lib/inventory/api';
import { isQuantity, shortQuantity } from '../../lib/inventory/format';
import { useActionKey } from '../../lib/use-action-key';
import { Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import type { InventoryData } from './inventory-page';

/** Stock items: name, article number, unit and reorder level; managed with inventory.items.edit. */
export function ItemsTab({ data }: { data: InventoryData }) {
  const t = useT();
  const [showArchived, setShowArchived] = useState(false);
  const canManage = data.can('inventory.items.edit');
  const shown = data.items.filter((i) => showArchived || i.archivedAt === null);
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
        {canManage && <ItemDialog categories={data.categories} onDone={data.reload} />}
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground">{t('inventory.page.noItems')}</p>
      ) : (
        <Card className="divide-y p-0">
          {shown.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              data-testid="item-row"
              data-name={item.name}
            >
              <span className="flex flex-col">
                <span className="flex items-center gap-2 font-medium">
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
              </span>
              {canManage && (
                <span className="flex gap-2">
                  <ItemDialog item={item} categories={data.categories} onDone={data.reload} />
                  <ArchiveButton item={item} onDone={data.reload} />
                </span>
              )}
            </div>
          ))}
        </Card>
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
}: {
  item?: StockItem;
  categories: readonly ProductCategory[] | null;
  onDone: () => void;
  trigger?: string;
  /** Pre-filled for a new item, e.g. the category open on the inventory page. */
  defaultCategoryId?: string | null;
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
  const [checked, setChecked] = useState(false);
  // Active categories to choose from, plus the item's own even if archived meanwhile (it stays until changed).
  const choices = (categories ?? []).filter(
    (c) => c.archivedAt === null || c.id === item?.categoryId,
  );
  const parentName = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const choiceLabel = (c: ProductCategory) =>
    c.parentId ? `${parentName.get(c.parentId) ?? ''} › ${c.name}` : c.name;
  // The default price on sales orders (ADR 0044): only where the organization has orders.
  const sells = session?.activeFeatures.includes('orders') ?? false;
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
        return createStockItem(store, action, {
          name: name.trim(),
          unit,
          ...(sku.trim() ? { sku: sku.trim() } : {}),
          ...(min.trim() ? { minQuantity: min.trim() } : {}),
          ...(sells && salePrice.trim() ? { salePrice: salePrice.trim() } : {}),
          ...(categories && categoryId ? { categoryId } : {}),
        });
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
    </FormDialog>
  );
}
