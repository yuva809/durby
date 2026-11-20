'use client';

import type { Order } from '@durby/shared';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadFloor, transferOrder } from '../../lib/pos/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Field, FormDialog } from '../form-dialog';
import { Input } from '../ui/input';
import { Select } from '../ui/select';

/**
 * Moves chosen sent items to a new order at a free table (docs/modules/pos.md → Step 5, ADR 0069). The order keeps a
 * void for them; the new order sells them at the same prices. The till then opens the new order.
 */
export function TransferDialog({ order }: { order: Order }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const router = useRouter();
  const id = useId();
  const [floor] = useResource(order.id, () => loadFloor(store, order.locationId));
  const [tableId, setTableId] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  // Only what is left and not on a bill can move.
  const movable = order.tickets
    .flatMap((ticket) => ticket.lines)
    .filter((line) => line.quantity > 0 && line.remaining - line.billedQuantity > 0)
    .map((line) => ({ line, max: line.remaining - line.billedQuantity }));
  const free =
    floor.status === 'ready'
      ? floor.data.filter((table) => table.order === null && table.locationId === order.locationId)
      : [];
  const picked = movable
    .map(({ line, max }) => ({ lineId: line.id, quantity: Number(amounts[line.id] ?? 0), max }))
    .filter((p) => p.quantity > 0);
  const nothing = checked && picked.length === 0;
  return (
    <FormDialog
      trigger={t('pos.order.transfer')}
      triggerVariant="outline"
      testId="transfer-order"
      title={t('pos.order.transferTitle')}
      submitLabel={t('pos.order.transfer')}
      onOpen={() => {
        setTableId('');
        setAmounts({});
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (picked.length === 0 || tableId === '') return null;
        return transferOrder(store, action, order.id, {
          tableId,
          lines: picked.map((p) => ({ lineId: p.lineId, quantity: p.quantity })),
        });
      }}
      onDone={() => router.push(`/service/${tableId}`)}
    >
      <fieldset className="flex flex-col gap-3" data-testid="transfer-lines">
        <legend className="text-sm font-medium">{t('pos.order.transferItems')}</legend>
        {movable.map(({ line, max }) => (
          <Field
            key={line.id}
            id={`${id}-${line.id}`}
            label={`${line.productName} (${max})`}
            problem={null}
          >
            <Input
              id={`${id}-${line.id}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={max}
              value={amounts[line.id] ?? ''}
              onChange={(e) => setAmounts((a) => ({ ...a, [line.id]: e.target.value }))}
              data-testid="transfer-quantity"
            />
          </Field>
        ))}
        {nothing && <p className="text-sm text-destructive">{t('pos.order.transferNothing')}</p>}
      </fieldset>
      {free.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pos.order.moveNone')}</p>
      ) : (
        <Field id={`${id}-table`} label={t('pos.order.moveTable')} problem={null}>
          <Select
            id={`${id}-table`}
            value={tableId}
            onChange={(e) => setTableId(e.target.value)}
            data-testid="transfer-table"
          >
            <option value="">—</option>
            {free.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </FormDialog>
  );
}
