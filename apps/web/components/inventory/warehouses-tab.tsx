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
import type { InventoryData } from './inventory-page';

/** Warehouses per location (main store, kitchen, bar, cold room); managed with the key there. */
export function WarehousesTab({ data }: { data: InventoryData }) {
  const t = useT();
  const [showArchived, setShowArchived] = useState(false);
  const canManage = data.can('inventory.warehouses.manage');
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
                      {w.archivedAt && <Badge>{t('inventory.page.archived')}</Badge>}
                    </span>
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
  const [checked, setChecked] = useState(false);
  const nameMissing = checked && name.trim() === '';

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
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '') return null;
        return warehouse
          ? updateWarehouse(store, action, warehouse.id, {
              name: name.trim(),
              suppliesStation,
            })
          : createWarehouse(store, action, { locationId, name: name.trim() });
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
      <Field id={`${id}-station`} label={t('inventory.fields.suppliesStation')} problem={null}>
        <Select
          id={`${id}-station`}
          value={suppliesStation ?? ''}
          onChange={(e) => setSuppliesStation(e.target.value || null)}
        >
          <option value="">{t('inventory.stations.none')}</option>
          <option value="kitchen">{t('inventory.stations.kitchen')}</option>
          <option value="bar">{t('inventory.stations.bar')}</option>
        </Select>
      </Field>
    </FormDialog>
  );
}
