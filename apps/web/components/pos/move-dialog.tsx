'use client';

import type { Order } from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadFloor, moveOrder } from '../../lib/pos/api';
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
