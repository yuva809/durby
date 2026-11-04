'use client';

import {
  ADJUSTMENT_REASONS,
  type AdjustmentReason,
  INVENTORY_NOTE_MAX_LENGTH,
  type PermissionKey,
} from '@durby/shared';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { postAdjustment, postReceipt, postTransfer } from '../../lib/inventory/api';
import {
  isQuantity,
  isSignedQuantity,
  isUnitCost,
  lineValue,
  sumValues,
} from '../../lib/inventory/format';
import { useActionKey } from '../../lib/use-action-key';
import { cn } from '../../lib/utils';
import { useMoney } from '../pos/money';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { type InventoryData, warehouseLabel } from './inventory-page';

type Kind = 'receive' | 'adjust' | 'transfer';

interface Line {
  key: number;
  itemId: string;
  quantity: string;
  unitCost: string;
}

const KEYS: Record<Kind, PermissionKey> = {
  receive: 'inventory.stock.receive',
  adjust: 'inventory.stock.adjust',
  transfer: 'inventory.stock.transfer',
};

/**
 * A receipt, an adjustment or a transfer (docs/modules/inventory.md): the warehouse(s), the lines
 * (item, quantity and, for a receipt, unit cost) with a live total, then Book. The api values and
 * checks everything again; a booked document shows its number and the form starts over.
 */
export function DocumentForm({ kind, data }: { kind: Kind; data: InventoryData }) {
  const t = useT();
  const id = useId();
  const money = useMoney();
  const { store } = useAuth();
  const action = useActionKey();
  const warehouses = data.warehouses.filter((w) => w.archivedAt === null);
  const items = data.items.filter((i) => i.archivedAt === null);
  const [from, setFrom] = useState(warehouses[0]?.id ?? '');
  const [to, setTo] = useState(warehouses[1]?.id ?? '');
  const [reason, setReason] = useState<AdjustmentReason>('waste');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: 0, itemId: '', quantity: '', unitCost: '' }]);
  const [nextKey, setNextKey] = useState(1);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  if (warehouses.length === 0) {
    return <p className="text-muted-foreground">{t('inventory.page.noWarehouses')}</p>;
  }
  if (items.length === 0) {
    return <p className="text-muted-foreground">{t('inventory.page.noItems')}</p>;
  }

  const quantityOk = (q: string) => (kind === 'adjust' ? isSignedQuantity(q) : isQuantity(q));
  const lineProblems = (l: Line) => ({
    item: l.itemId === '',
    quantity: !quantityOk(l.quantity),
    cost: kind === 'receive' && !isUnitCost(l.unitCost),
  });
  const filled = lines.filter((l) => l.itemId || l.quantity || l.unitCost);
  const invalid =
    filled.length === 0 || filled.some((l) => Object.values(lineProblems(l)).some(Boolean));
  const total =
    kind === 'receive'
      ? sumValues(filled.map((l) => lineValue(l.quantity.trim(), l.unitCost.trim()) ?? '0.00'))
      : null;
  const unitOf = (itemId: string) => items.find((i) => i.id === itemId)?.unit;
  const label = (warehouseId: string) => {
    const w = warehouses.find((x) => x.id === warehouseId);
    return w ? warehouseLabel(data, w) : '';
  };

  const change = (key: number, patch: Partial<Line>) => {
    setPosted(null);
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (invalid || (kind === 'transfer' && from === to)) {
      setError(
        t(
          kind === 'transfer' && from === to
            ? 'inventory.errors.sameWarehouse'
            : 'inventory.page.invalid',
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    const noteText = note.trim() ? { note: note.trim() } : {};
    const result =
      kind === 'receive'
        ? await postReceipt(store, action, {
            warehouseId: from,
            ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
            ...noteText,
            lines: filled.map((l) => ({
              itemId: l.itemId,
              quantity: l.quantity.trim(),
              unitCost: l.unitCost.trim(),
            })),
          })
        : kind === 'adjust'
          ? await postAdjustment(store, action, {
              warehouseId: from,
              reason,
              ...noteText,
              lines: filled.map((l) => ({ itemId: l.itemId, quantity: l.quantity.trim() })),
            })
          : await postTransfer(store, action, {
              fromWarehouseId: from,
              toWarehouseId: to,
              ...noteText,
              lines: filled.map((l) => ({ itemId: l.itemId, quantity: l.quantity.trim() })),
            });
    setBusy(false);
    if (result.ok && result.data) {
      setPosted(t('inventory.page.posted', { number: result.data.number }));
      setLines([{ key: nextKey, itemId: '', quantity: '', unitCost: '' }]);
      setNextKey((k) => k + 1);
      setSupplier('');
      setNote('');
      setChecked(false);
      data.reload();
    } else if (!result.ok) {
      setError(t(errorLabel(result.code)));
    }
  }

  const warehouseSelect = (
    value: string,
    onChange: (v: string) => void,
    labelKey:
      | 'inventory.fields.warehouse'
      | 'inventory.fields.fromWarehouse'
      | 'inventory.fields.toWarehouse',
    testId: string,
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-${testId}`}>{t(labelKey)}</Label>
      <Select
        id={`${id}-${testId}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      >
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>
            {label(w.id)}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <form className="flex max-w-4xl flex-col gap-5" onSubmit={(e) => void submit(e)} noValidate>
      <Card className="grid gap-4 p-4 sm:grid-cols-2">
        {kind === 'transfer' ? (
          <>
            {warehouseSelect(from, setFrom, 'inventory.fields.fromWarehouse', 'doc-from')}
            {warehouseSelect(to, setTo, 'inventory.fields.toWarehouse', 'doc-to')}
          </>
        ) : (
          warehouseSelect(from, setFrom, 'inventory.fields.warehouse', 'doc-warehouse')
        )}
        {kind === 'receive' && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-supplier`}>{t('inventory.fields.supplier')}</Label>
            <Input
              id={`${id}-supplier`}
              value={supplier}
              maxLength={100}
              onChange={(e) => setSupplier(e.target.value)}
              data-testid="doc-supplier"
            />
          </div>
        )}
        {kind === 'adjust' && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-reason`}>{t('inventory.fields.reason')}</Label>
            <Select
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value as AdjustmentReason)}
              data-testid="doc-reason"
            >
              {ADJUSTMENT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`inventory.reasons.${r}`)}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-note`}>{t('inventory.fields.note')}</Label>
          <Input
            id={`${id}-note`}
            value={note}
            maxLength={INVENTORY_NOTE_MAX_LENGTH}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        {kind === 'adjust' && (
          <p className="text-sm text-muted-foreground">{t('inventory.page.adjustHint')}</p>
        )}
        <ul className="flex flex-col gap-3">
          {lines.map((line, index) => {
            const problems = checked
              ? lineProblems(line)
              : { item: false, quantity: false, cost: false };
            const unit = unitOf(line.itemId);
            const value =
              kind === 'receive' ? lineValue(line.quantity.trim(), line.unitCost.trim()) : null;
            const itemName = items.find((i) => i.id === line.itemId)?.name ?? String(index + 1);
            return (
              <li
                key={line.key}
                className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                data-testid="doc-line"
              >
                <div className="col-span-2 grid gap-1.5 sm:col-span-1">
                  <Label htmlFor={`${id}-item-${line.key}`}>{t('inventory.fields.item')}</Label>
                  <Select
                    id={`${id}-item-${line.key}`}
                    value={line.itemId}
                    aria-invalid={problems.item || undefined}
                    onChange={(e) => change(line.key, { itemId: e.target.value })}
                    data-testid="doc-item"
                  >
                    <option value="">{t('inventory.page.chooseItem')}</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${id}-qty-${line.key}`}>
                    {t('inventory.fields.quantity')}
                    {unit && ` (${t(`inventory.units.${unit}`)})`}
                  </Label>
                  <Input
                    id={`${id}-qty-${line.key}`}
                    inputMode="decimal"
                    value={line.quantity}
                    aria-invalid={problems.quantity || undefined}
                    className={cn('tabular-nums', problems.quantity && 'border-destructive')}
                    onChange={(e) =>
                      change(line.key, { quantity: e.target.value.replace(',', '.') })
                    }
                    data-testid="doc-quantity"
                  />
                </div>
                {kind === 'receive' ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-cost-${line.key}`}>
                      {t('inventory.fields.unitCost')}
                    </Label>
                    <Input
                      id={`${id}-cost-${line.key}`}
                      inputMode="decimal"
                      value={line.unitCost}
                      aria-invalid={problems.cost || undefined}
                      className={cn('tabular-nums', problems.cost && 'border-destructive')}
                      onChange={(e) =>
                        change(line.key, { unitCost: e.target.value.replace(',', '.') })
                      }
                      data-testid="doc-cost"
                    />
                  </div>
                ) : (
                  <span className="hidden sm:block" />
                )}
                <div className="flex items-center justify-end gap-2">
                  {value && (
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {money(value)}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    className="size-11 px-0"
                    disabled={lines.length === 1}
                    aria-label={t('inventory.page.removeLine', { name: itemName })}
                    onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() => {
              setLines((ls) => [...ls, { key: nextKey, itemId: '', quantity: '', unitCost: '' }]);
              setNextKey((k) => k + 1);
            }}
            data-testid="doc-add-line"
          >
            <Plus aria-hidden />
            {t('inventory.page.addLine')}
          </Button>
          {total !== null && (
            <p className="font-semibold tabular-nums" data-testid="doc-total">
              {t('inventory.page.lineTotal', { value: money(total) })}
            </p>
          )}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          className="min-h-11"
          disabled={busy || !data.can(KEYS[kind])}
          data-testid="doc-post"
        >
          {t('inventory.page.post')}
        </Button>
        <Notice text={error} tone="error" />
        <Notice text={posted} tone="info" />
      </div>
    </form>
  );
}
