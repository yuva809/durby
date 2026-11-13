'use client';

import { BOM_MAX_LINES, type Bom, type StockItem } from '@durby/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { deleteBom, loadBoms, loadStockItems, putBom } from '../../lib/inventory/api';
import { isQuantity, shortQuantity } from '../../lib/inventory/format';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { ConfirmAction, Loaded } from '../users/common';
import { InventorySubPage } from './sub-page';

interface Line {
  key: number;
  itemId: string;
  quantity: string;
}

/** Items a bill can name: active and not a parent with variants (it holds no stock, ADR 0038). */
export function stockableItems(items: readonly StockItem[]): StockItem[] {
  const parents = new Set(
    items.filter((i) => i.parentItemId && i.archivedAt === null).map((i) => i.parentItemId),
  );
  return items.filter((i) => i.archivedAt === null && !parents.has(i.id));
}

/** Inventory → Bills of Materials (ADR 0038): what a batch of a prepared item takes. */
export function BomsPage() {
  return (
    <InventorySubPage title="inventory.nav.bom" description="inventory.boms.description">
      {({ organizationId, can }) => (
        <Boms
          organizationId={organizationId}
          canEdit={can('inventory.recipes.edit')}
          canDelete={can('inventory.recipes.delete')}
        />
      )}
    </InventorySubPage>
  );
}

function Boms({
  organizationId,
  canEdit,
  canDelete,
}: {
  organizationId: string | null;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [boms, reloadBoms] = useResource(organizationId, () => loadBoms(store));
  const [items, reloadItems] = useResource(organizationId, () => loadStockItems(store, true));
  const reload = () => {
    reloadBoms();
    reloadItems();
  };
  return (
    <Loaded resource={items} reload={reload}>
      {(itemList) => (
        <Loaded resource={boms} reload={reload}>
          {(bomList) => {
            const usable = stockableItems(itemList);
            const withBill = new Set(bomList.map((b) => b.itemId));
            return (
              <div className="flex flex-col gap-4">
                {canEdit && (
                  <div className="flex justify-end">
                    <BomDialog
                      items={usable}
                      outputs={usable.filter((i) => !withBill.has(i.id))}
                      onDone={reloadBoms}
                    />
                  </div>
                )}
                {bomList.length === 0 ? (
                  <p className="text-muted-foreground">{t('inventory.boms.empty')}</p>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-2">
                    {bomList.map((bom) => (
                      <Card key={bom.itemId} className="flex flex-col p-0" data-testid="bom-card">
                        <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
                          <span className="flex flex-col">
                            <span className="font-medium">{bom.itemName}</span>
                            <span className="text-sm text-muted-foreground tabular-nums">
                              {t('inventory.boms.makes', {
                                quantity: shortQuantity(bom.outputQuantity),
                                unit: t(`inventory.units.${bom.unit}`),
                              })}
                            </span>
                          </span>
                          <span className="flex gap-2">
                            {canEdit && <BomDialog bom={bom} items={usable} onDone={reloadBoms} />}
                            {canDelete && <DeleteBom bom={bom} onDone={reloadBoms} />}
                          </span>
                        </div>
                        <ul className="divide-y text-sm">
                          {bom.lines.map((line) => (
                            <li
                              key={line.itemId}
                              className="flex items-center justify-between gap-3 px-4 py-2"
                            >
                              <span>{line.itemName}</span>
                              <span className="tabular-nums text-muted-foreground">
                                {shortQuantity(line.quantity)} {t(`inventory.units.${line.unit}`)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            );
          }}
        </Loaded>
      )}
    </Loaded>
  );
}

function DeleteBom({ bom, onDone }: { bom: Bom; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <ConfirmAction
      testId="bom-delete"
      trigger={t('inventory.boms.delete')}
      title={t('inventory.boms.deleteTitle', { name: bom.itemName })}
      description={t('inventory.boms.deleteDescription')}
      confirm={t('inventory.boms.delete')}
      run={() => deleteBom(store, action, bom.itemId)}
      onDone={onDone}
    />
  );
}

function BomDialog({
  bom,
  items,
  outputs,
  onDone,
}: {
  /** Absent: a new bill. */
  bom?: Bom;
  items: StockItem[];
  /** Items that may get a new bill (those without one). */
  outputs?: StockItem[];
  onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [itemId, setItemId] = useState('');
  const [output, setOutput] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [nextKey, setNextKey] = useState(0);
  const [checked, setChecked] = useState(false);
  const filled = lines.filter((l) => l.itemId || l.quantity);
  const itemMissing = checked && itemId === '';
  const outputInvalid = checked && !isQuantity(output);
  const lineProblem = (l: Line) => ({
    item: checked && (l.itemId === '' || l.itemId === itemId),
    quantity: checked && !isQuantity(l.quantity),
  });
  const duplicate =
    new Set(filled.map((l) => l.itemId)).size !== filled.length && filled.every((l) => l.itemId);
  const linesProblem = checked
    ? filled.length === 0
      ? t('inventory.boms.needsLine')
      : duplicate
        ? t('inventory.boms.duplicate')
        : null
    : null;
  const unitOf = (key: string) => items.find((i) => i.id === key)?.unit;
  const addLine = () => {
    setLines((ls) => [...ls, { key: nextKey, itemId: '', quantity: '' }]);
    setNextKey((k) => k + 1);
  };

  return (
    <FormDialog
      trigger={t(bom ? 'inventory.page.edit' : 'inventory.boms.add')}
      triggerVariant={bom ? 'outline' : 'default'}
      testId={bom ? 'bom-edit' : 'bom-create'}
      title={bom ? t('inventory.boms.editTitle', { name: bom.itemName }) : t('inventory.boms.add')}
      onOpen={() => {
        setItemId(bom?.itemId ?? '');
        setOutput(bom ? shortQuantity(bom.outputQuantity) : '1');
        const start = bom
          ? bom.lines.map((l, i) => ({
              key: i,
              itemId: l.itemId,
              quantity: shortQuantity(l.quantity),
            }))
          : [{ key: 0, itemId: '', quantity: '' }];
        setLines(start);
        setNextKey(start.length);
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        const bad = filled.some(
          (l) => l.itemId === '' || l.itemId === itemId || !isQuantity(l.quantity),
        );
        if (!itemId || !isQuantity(output) || filled.length === 0 || bad || duplicate) return null;
        return putBom(store, action, itemId, {
          outputQuantity: output.trim(),
          lines: filled.map((l) => ({ itemId: l.itemId, quantity: l.quantity.trim() })),
        });
      }}
      onDone={onDone}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field
          id={`${id}-item`}
          label={t('inventory.boms.output')}
          problem={itemMissing ? t('inventory.page.chooseItem') : null}
        >
          <Select
            id={`${id}-item`}
            value={itemId}
            disabled={bom !== undefined}
            aria-invalid={itemMissing || undefined}
            onChange={(e) => setItemId(e.target.value)}
            data-testid="bom-item"
          >
            <option value="">{t('inventory.page.chooseItem')}</option>
            {(bom ? items : (outputs ?? items)).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          id={`${id}-output`}
          label={`${t('inventory.boms.outputQuantity')}${unitOf(itemId) ? ` (${t(`inventory.units.${unitOf(itemId)!}`)})` : ''}`}
          problem={outputInvalid ? t('inventory.page.quantityInvalid') : null}
        >
          <Input
            id={`${id}-output`}
            inputMode="decimal"
            value={output}
            aria-invalid={outputInvalid || undefined}
            className="tabular-nums"
            onChange={(e) => setOutput(e.target.value.replace(',', '.'))}
            data-testid="bom-output"
          />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('inventory.boms.components')}</legend>
        <ul className="flex flex-col gap-2">
          {lines.map((line, index) => {
            const problems = lineProblem(line);
            const unit = unitOf(line.itemId);
            return (
              <li
                key={line.key}
                className="grid grid-cols-[minmax(0,1fr)_6.5rem_auto] items-end gap-2"
                data-testid="bom-line"
              >
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-line-${line.key}`} className="sr-only">
                    {t('inventory.fields.item')}
                  </Label>
                  <Select
                    id={`${id}-line-${line.key}`}
                    value={line.itemId}
                    aria-invalid={problems.item || undefined}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l) => (l.key === line.key ? { ...l, itemId: e.target.value } : l)),
                      )
                    }
                    data-testid="bom-line-item"
                  >
                    <option value="">{t('inventory.page.chooseItem')}</option>
                    {items
                      .filter((i) => i.id !== itemId)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-qty-${line.key}`} className="sr-only">
                    {t('inventory.fields.quantity')}
                  </Label>
                  <Input
                    id={`${id}-qty-${line.key}`}
                    inputMode="decimal"
                    value={line.quantity}
                    placeholder={
                      unit ? t(`inventory.units.${unit}`) : t('inventory.fields.quantity')
                    }
                    aria-invalid={problems.quantity || undefined}
                    className={cn('tabular-nums', problems.quantity && 'border-destructive')}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l) =>
                          l.key === line.key
                            ? { ...l, quantity: e.target.value.replace(',', '.') }
                            : l,
                        ),
                      )
                    }
                    data-testid="bom-line-quantity"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="size-11 px-0"
                  disabled={lines.length === 1}
                  aria-label={t('inventory.page.removeLine', {
                    name: items.find((i) => i.id === line.itemId)?.name ?? String(index + 1),
                  })}
                  onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        {linesProblem && (
          <p role="alert" className="text-sm text-destructive">
            {linesProblem}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="gap-2 self-start"
          disabled={lines.length >= BOM_MAX_LINES}
          onClick={addLine}
          data-testid="bom-add-line"
        >
          <Plus aria-hidden />
          {t('inventory.page.addLine')}
        </Button>
      </fieldset>
    </FormDialog>
  );
}
