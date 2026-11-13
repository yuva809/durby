'use client';

import { STOCK_UNITS, type StockItem, type StockUnit } from '@durby/shared';
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
        {canManage && <ItemDialog onDone={data.reload} />}
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
                  <ItemDialog item={item} onDone={data.reload} />
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

function ItemDialog({ item, onDone }: { item?: StockItem; onDone: () => void }) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [unit, setUnit] = useState<StockUnit>('kg');
  const [min, setMin] = useState('');
  const [checked, setChecked] = useState(false);
  const nameMissing = checked && name.trim() === '';
  const minInvalid = checked && min.trim() !== '' && !isQuantity(min);

  return (
    <FormDialog
      trigger={t(item ? 'inventory.page.edit' : 'inventory.page.addItem')}
      triggerVariant={item ? 'outline' : 'default'}
      testId={item ? 'item-edit' : 'item-create'}
      title={t(item ? 'inventory.page.editItem' : 'inventory.page.addItem')}
      onOpen={() => {
        setName(item?.name ?? '');
        setSku(item?.sku ?? '');
        setUnit(item?.unit ?? 'kg');
        setMin(item?.minQuantity ? shortQuantity(item.minQuantity) : '');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '' || (min.trim() !== '' && !isQuantity(min))) return null;
        if (item) {
          return updateStockItem(store, action, item.id, {
            name: name.trim(),
            sku: sku.trim() || null,
            unit,
            minQuantity: min.trim() || null,
          });
        }
        return createStockItem(store, action, {
          name: name.trim(),
          unit,
          ...(sku.trim() ? { sku: sku.trim() } : {}),
          ...(min.trim() ? { minQuantity: min.trim() } : {}),
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
    </FormDialog>
  );
}
