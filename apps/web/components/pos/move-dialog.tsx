'use client';

import type { Order } from '@durby/shared';
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadFloor, mergeOrder, moveOrder } from '../../lib/pos/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Field, FormDialog } from '../form-dialog';
import { Select } from '../ui/select';

/**
 * Moves an open order to a free table at its location (docs/modules/pos.md → Step 5, ADR 0069). The kitchen is not
 * reprinted: the order keeps its tickets and lines.
 */
export function MoveDialog({ order, onDone }: { order: Order; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [floor] = useResource(order.id, () => loadFloor(store, order.locationId));
  const [tableId, setTableId] = useState('');
  const free =
    floor.status === 'ready'
      ? floor.data.filter((table) => table.order === null && table.locationId === order.locationId)
      : [];
  return (
    <FormDialog
      trigger={t('pos.order.move')}
      triggerVariant="outline"
      testId="move-order"
      title={t('pos.order.moveTitle')}
      submitLabel={t('pos.order.move')}
      onOpen={() => setTableId('')}
      submit={() => (tableId === '' ? null : moveOrder(store, action, order.id, tableId))}
      onDone={onDone}
    >
      {free.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pos.order.moveNone')}</p>
      ) : (
        <Field id={`${id}-table`} label={t('pos.order.moveTable')} problem={null}>
          <Select
            id={`${id}-table`}
            value={tableId}
            onChange={(e) => setTableId(e.target.value)}
            data-testid="move-table"
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

/**
 * Merges this open order into another open order at its location (docs/modules/pos.md → Step 5, ADR 0069): the
 * other order takes this order's tickets, and this table is freed. The till then opens the other table.
 */
export function MergeDialog({ order }: { order: Order }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const router = useRouter();
  const id = useId();
  const [floor] = useResource(order.id, () => loadFloor(store, order.locationId));
  const [tableId, setTableId] = useState('');
  const nextTable = useRef<string | null>(null);
  const open =
    floor.status === 'ready'
      ? floor.data.filter(
          (table) =>
            table.order !== null &&
            table.order.id !== order.id &&
            table.locationId === order.locationId,
        )
      : [];
  return (
    <FormDialog
      trigger={t('pos.order.merge')}
      triggerVariant="outline"
      testId="merge-order"
      title={t('pos.order.mergeTitle')}
      submitLabel={t('pos.order.merge')}
      onOpen={() => setTableId('')}
      submit={() => {
        const target = open.find((table) => table.id === tableId);
        if (!target?.order) return null;
        nextTable.current = target.id;
        return mergeOrder(store, action, order.id, target.order.id);
      }}
      onDone={() => {
        if (nextTable.current) router.push(`/service/${nextTable.current}`);
      }}
    >
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pos.order.mergeNone')}</p>
      ) : (
        <Field id={`${id}-table`} label={t('pos.order.mergeTarget')} problem={null}>
          <Select
            id={`${id}-table`}
            value={tableId}
            onChange={(e) => setTableId(e.target.value)}
            data-testid="merge-table"
          >
            <option value="">—</option>
            {open.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name} · {table.order?.number}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </FormDialog>
  );
}
