'use client';

import type { Warehouse } from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createWarehouse, updateWarehouse } from '../../lib/inventory/api';
import { useActionKey } from '../../lib/use-action-key';
import { Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { cn } from '../../lib/utils';
import { useNavLayout } from '../theme-provider';
import type { InventoryData } from './inventory-page';

/** Which branches a warehouse supplies (ADR 0067): every one (the main warehouse), the ones ticked, or none. */
type Supply = 'all' | 'some' | 'none';
const supplyOf = (w: Warehouse | undefined): Supply =>
  w?.isMain ? 'all' : (w?.suppliesLocationIds.length ?? 0) > 0 ? 'some' : 'none';
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** Warehouses per location (main store, kitchen, bar, cold room); managed with the key there. */
export function WarehousesTab({ data }: { data: InventoryData }) {
  const t = useT();
  const [showArchived, setShowArchived] = useState(false);
  const canManage = data.can('inventory.warehouses.edit');
  const locations =
    data.locations.length > 0
      ? data.locations
      : [...new Set(data.warehouses.map((w) => w.locationId))].map((id) => ({
          id,
          name: '',
          brandId: '',
        }));
  if (locations.length === 0) {
    return <p className="text-muted-foreground">{t('inventory.page.noLocations')}</p>;
  }
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
        {canManage && data.locations.length > 0 && (
          <WarehouseDialog data={data} onDone={data.reload} />
        )}
      </div>
      {locations.map((location) => {
        const list = data.warehouses.filter(
          (w) => w.locationId === location.id && (showArchived || w.archivedAt === null),
        );
        return (
          <section
            key={location.id}
            className="flex flex-col gap-2"
            data-testid="warehouse-location"
          >
            {location.name && <h2 className="font-semibold">{location.name}</h2>}
            {list.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('inventory.page.noWarehouses')}</p>
            ) : (
              <Card className="divide-y p-0">
                {list.map((w) => (
                  <div
                    key={w.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    data-testid="warehouse-row"
                    data-name={w.name}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      {w.name}
                      {w.suppliesStation && (
                        <Badge className="bg-muted text-foreground">
                          {t(`inventory.stations.${w.suppliesStation}`)}
                        </Badge>
                      )}
                      {w.isMain && (
                        <Badge
                          className="bg-primary text-primary-foreground"
                          data-testid="warehouse-main"
                        >
                          {t('inventory.page.mainWarehouse')}
                        </Badge>
                      )}
                      {w.archivedAt && <Badge>{t('inventory.page.archived')}</Badge>}
                    </span>
                    {w.suppliesLocationIds.length > 0 && (
                      <span
                        className="basis-full text-sm text-muted-foreground"
                        data-testid="warehouse-supplies"
                      >
                        {t('inventory.page.suppliesBranches', {
                          names: w.suppliesLocationIds
                            .map((l) => data.locations.find((x) => x.id === l)?.name ?? '')
                            .filter(Boolean)
                            .join(', '),
                        })}
                      </span>
                    )}
                    {canManage && (
                      <span className="flex gap-2">
                        <WarehouseDialog data={data} warehouse={w} onDone={data.reload} />
                        <ArchiveButton warehouse={w} onDone={data.reload} />
                      </span>
                    )}
                  </div>
                ))}
              </Card>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ArchiveButton({ warehouse, onDone }: { warehouse: Warehouse; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [busy, setBusy] = useState(false);
  const archived = warehouse.archivedAt !== null;
  return (
    <Button
      variant="outline"
      disabled={busy}
      data-testid={archived ? 'warehouse-restore' : 'warehouse-archive'}
      onClick={() => {
        setBusy(true);
        void updateWarehouse(store, action, warehouse.id, { archived: !archived }).then(() => {
          setBusy(false);
          onDone();
        });
      }}
    >
      {t(archived ? 'inventory.page.restore' : 'inventory.page.archive')}
    </Button>
  );
}

function WarehouseDialog({
  data,
  warehouse,
  onDone,
}: {
  data: InventoryData;
  warehouse?: Warehouse;
  onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [suppliesStation, setSuppliesStation] = useState<'kitchen' | 'bar' | null>(null);
  const [supply, setSupply] = useState<Supply>('none');
  const [supplied, setSupplied] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  // Kitchen and bar stations are for restaurants; the operations menu (branches and a warehouse) has none.
  const operations = useNavLayout() === 'operations';
  const nameMissing = checked && name.trim() === '';
  const noneTicked = checked && supply === 'some' && supplied.length === 0;
  const here = warehouse?.locationId ?? locationId;
  // Who supplies each branch now, to say where a ticked branch moves from.
  const supplierOf = (location: string) =>
    data.warehouses.find(
      (w) =>
        w.id !== warehouse?.id && w.archivedAt === null && w.suppliesLocationIds.includes(location),
    );

  return (
    <FormDialog
      trigger={t(warehouse ? 'inventory.page.edit' : 'inventory.page.addWarehouse')}
      triggerVariant={warehouse ? 'outline' : 'default'}
      testId={warehouse ? 'warehouse-edit' : 'warehouse-create'}
      title={t(warehouse ? 'inventory.page.editWarehouse' : 'inventory.page.addWarehouse')}
      onOpen={() => {
        setName(warehouse?.name ?? '');
        setLocationId(warehouse?.locationId ?? data.locations[0]?.id ?? '');
        setSuppliesStation(warehouse?.suppliesStation ?? null);
        setSupply(supplyOf(warehouse));
        setSupplied(warehouse?.suppliesLocationIds ?? []);
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '') return null;
        if (supply === 'some' && supplied.length === 0) return null;
        const isMain = supply === 'all';
        // Never its own location: a warehouse supplies the other branches.
        const ids = supply === 'some' ? supplied.filter((l) => l !== here) : [];
        if (!warehouse) {
          return createWarehouse(store, action, {
            locationId,
            name: name.trim(),
            ...(isMain ? { isMain } : {}),
            ...(ids.length > 0 ? { suppliesLocationIds: ids } : {}),
          });
        }
        return updateWarehouse(store, action, warehouse.id, {
          name: name.trim(),
          suppliesStation,
          // Sent only when changed: choosing them needs warehouse rights everywhere (ADR 0053, 0067).
          ...(isMain !== warehouse.isMain ? { isMain } : {}),
          ...(sameIds(ids, warehouse.suppliesLocationIds) ? {} : { suppliesLocationIds: ids }),
        });
      }}
      onDone={onDone}
    >
      {!warehouse && data.locations.length > 1 && (
        <Field id={`${id}-location`} label={t('inventory.fields.location')} problem={null}>
          <Select
            id={`${id}-location`}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            {data.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          {/* A place, not who it supplies: a main warehouse at a shop's location mixes it up with that shop (item 1). */}
          <p className="text-xs text-muted-foreground" data-testid="warehouse-location-hint">
            {t('inventory.page.warehouseLocationHint')}
          </p>
        </Field>
      )}
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
      {!operations && (
        <Field id={`${id}-station`} label={t('inventory.fields.suppliesStation')} problem={null}>
          <Select
            id={`${id}-station`}
            value={suppliesStation ?? ''}
            onChange={(e) => setSuppliesStation((e.target.value as 'kitchen' | 'bar') || null)}
          >
            <option value="">{t('inventory.stations.none')}</option>
            <option value="kitchen">{t('inventory.stations.kitchen')}</option>
            <option value="bar">{t('inventory.stations.bar')}</option>
          </Select>
        </Field>
      )}
      {!warehouse?.isTransit && (
        <fieldset className="flex flex-col gap-2" data-testid="warehouse-supply">
          <legend className="mb-1 text-sm font-medium">{t('inventory.page.supplyTitle')}</legend>
          {(['all', 'some', 'none'] as const)
            // Only these branches: when there is another location to tick.
            .filter((choice) => choice !== 'some' || data.locations.some((l) => l.id !== here))
            .map((choice) => (
              <label
                key={choice}
                className={cn(
                  'flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm',
                  supply === choice ? 'border-primary bg-accent' : 'bg-card',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-supply`}
                  value={choice}
                  checked={supply === choice}
                  onChange={() => setSupply(choice)}
                  className="mt-1 accent-primary"
                  data-testid={`warehouse-supply-${choice}`}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{t(SUPPLY_LABELS[choice].name)}</span>
                  <span className="text-muted-foreground">{t(SUPPLY_LABELS[choice].hint)}</span>
                </span>
              </label>
            ))}
          {supply === 'some' && (
            <div className="flex flex-col gap-1 pl-3" data-testid="warehouse-supply-branches">
              {data.locations
                .filter((l) => l.id !== here)
                .map((l) => {
                  const from = supplierOf(l.id);
                  return (
                    <label key={l.id} className="flex min-h-11 items-center gap-3 text-sm">
                      <Checkbox
                        checked={supplied.includes(l.id)}
                        onCheckedChange={(next) =>
                          setSupplied((list) =>
                            next === true ? [...list, l.id] : list.filter((x) => x !== l.id),
                          )
                        }
                        data-testid="warehouse-supply-branch"
                        data-id={l.id}
                      />
                      <span>
                        {l.name}
                        {from && (
                          <span className="text-muted-foreground">
                            {' · '}
                            {t('inventory.page.supplyNow', { name: from.name })}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              {noneTicked && (
                <p role="alert" className="text-sm text-destructive">
                  {t('inventory.page.supplyPick')}
                </p>
              )}
            </div>
          )}
        </fieldset>
      )}
    </FormDialog>
  );
}

const SUPPLY_LABELS = {
  all: { name: 'inventory.page.supplyAll', hint: 'inventory.page.supplyAllHint' },
  some: { name: 'inventory.page.supplySome', hint: 'inventory.page.supplySomeHint' },
  none: { name: 'inventory.page.supplyNone', hint: 'inventory.page.supplyNoneHint' },
} as const;
