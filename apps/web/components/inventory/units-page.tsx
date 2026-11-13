'use client';

import { STOCK_UNITS, type StockUnit, type UnitOfMeasure, unitFactorSchema } from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createUnit, loadUnits, updateUnit } from '../../lib/inventory/api';
import { shortQuantity } from '../../lib/inventory/format';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { ArchiveToggle, Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Loaded } from '../users/common';
import { InventorySubPage } from './sub-page';

/** Inventory → Units of Measurement (ADR 0038): pack sizes receipts can be entered in. */
export function UnitsPage() {
  return (
    <InventorySubPage title="inventory.nav.units" description="inventory.uom.description">
      {({ organizationId, can }) => <Units organizationId={organizationId} can={can} />}
    </InventorySubPage>
  );
}

function Units({
  organizationId,
  can,
}: {
  organizationId: string | null;
  can: (key: 'inventory.items.create' | 'inventory.items.edit') => boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [showArchived, setShowArchived] = useState(false);
  const [units, reload] = useResource(
    organizationId === null ? null : `${organizationId}:${showArchived}`,
    () => loadUnits(store, showArchived),
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
        {can('inventory.items.create') && <UnitDialog onDone={reload} />}
      </div>
      <Loaded resource={units} reload={reload}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">{t('inventory.uom.empty')}</p>
          ) : (
            <Card className="divide-y p-0">
              {list.map((unit) => (
                <div
                  key={unit.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  data-testid="unit-row"
                  data-name={unit.name}
                >
                  <span className="flex flex-col">
                    <span className="flex items-center gap-2 font-medium">
                      {unit.name}
                      {unit.archivedAt && <Badge>{t('inventory.page.archived')}</Badge>}
                    </span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {t('inventory.uom.equals', {
                        symbol: unit.symbol,
                        factor: shortQuantity(unit.factor),
                        base: t(`inventory.units.${unit.baseUnit}`),
                      })}
                    </span>
                  </span>
                  {can('inventory.items.edit') && (
                    <span className="flex flex-wrap gap-2">
                      <UnitDialog unit={unit} onDone={reload} />
                      <ArchiveToggleFor unit={unit} onDone={reload} />
                    </span>
                  )}
                </div>
              ))}
            </Card>
          )
        }
      </Loaded>
    </div>
  );
}

function ArchiveToggleFor({ unit, onDone }: { unit: UnitOfMeasure; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <ArchiveToggle
      archived={unit.archivedAt !== null}
      labels={{
        archive: t('inventory.page.archive'),
        unarchive: t('inventory.page.restore'),
        title: t('inventory.uom.archiveTitle', { name: unit.name }),
        description: t('inventory.uom.archiveDescription'),
      }}
      run={(archived) => updateUnit(store, action, unit.id, { archived })}
      onDone={onDone}
    />
  );
}

function UnitDialog({ unit, onDone }: { unit?: UnitOfMeasure; onDone: () => void }) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [baseUnit, setBaseUnit] = useState<StockUnit>('pc');
  const [factor, setFactor] = useState('');
  const [checked, setChecked] = useState(false);
  const nameMissing = checked && name.trim() === '';
  const symbolMissing = checked && symbol.trim() === '';
  const factorInvalid = checked && !unitFactorSchema.safeParse(factor.trim()).success;

  return (
    <FormDialog
      trigger={t(unit ? 'inventory.page.edit' : 'inventory.uom.add')}
      triggerVariant={unit ? 'outline' : 'default'}
      testId={unit ? 'unit-edit' : 'unit-create'}
      title={t(unit ? 'inventory.uom.edit' : 'inventory.uom.add')}
      onOpen={() => {
        setName(unit?.name ?? '');
        setSymbol(unit?.symbol ?? '');
        setBaseUnit(unit?.baseUnit ?? 'pc');
        setFactor(unit ? shortQuantity(unit.factor) : '');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (!name.trim() || !symbol.trim() || !unitFactorSchema.safeParse(factor.trim()).success) {
          return null;
        }
        const body = { name: name.trim(), symbol: symbol.trim(), factor: factor.trim() };
        return unit
          ? updateUnit(store, action, unit.id, body)
          : createUnit(store, action, { ...body, baseUnit });
      }}
      onDone={onDone}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field
          id={`${id}-name`}
          label={t('inventory.fields.name')}
          problem={nameMissing ? t('inventory.page.nameRequired') : null}
        >
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            placeholder={t('inventory.uom.namePlaceholder')}
            aria-invalid={nameMissing || undefined}
            onChange={(e) => setName(e.target.value)}
            data-testid="unit-name"
          />
        </Field>
        <Field
          id={`${id}-symbol`}
          label={t('inventory.uom.symbol')}
          problem={symbolMissing ? t('inventory.uom.symbolRequired') : null}
        >
          <Input
            id={`${id}-symbol`}
            value={symbol}
            maxLength={20}
            aria-invalid={symbolMissing || undefined}
            onChange={(e) => setSymbol(e.target.value)}
            data-testid="unit-symbol"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${id}-factor`}
          label={t('inventory.uom.factor')}
          problem={factorInvalid ? t('inventory.uom.factorInvalid') : null}
        >
          <Input
            id={`${id}-factor`}
            inputMode="decimal"
            value={factor}
            aria-invalid={factorInvalid || undefined}
            onChange={(e) => setFactor(e.target.value.replace(',', '.'))}
            data-testid="unit-factor"
          />
        </Field>
        <Field id={`${id}-base`} label={t('inventory.uom.baseUnit')} problem={null}>
          <Select
            id={`${id}-base`}
            value={baseUnit}
            disabled={unit !== undefined}
            aria-describedby={unit ? `${id}-base-hint` : undefined}
            onChange={(e) => setBaseUnit(e.target.value as StockUnit)}
            data-testid="unit-base"
          >
            {STOCK_UNITS.map((u) => (
              <option key={u} value={u}>
                {t(`inventory.units.${u}`)}
              </option>
            ))}
          </Select>
          {unit && (
            <p id={`${id}-base-hint`} className="text-xs text-muted-foreground">
              {t('inventory.uom.baseUnitFixed')}
            </p>
          )}
        </Field>
      </div>
    </FormDialog>
  );
}
