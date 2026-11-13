'use client';

import type { FloorTable, Order } from '@durby/shared';
import { useEffect, useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { createBill } from '../../lib/pos/bills';
import { loadFloor } from '../../lib/pos/api';
import { useActionKey } from '../../lib/use-action-key';
import { Field, FormDialog } from '../form-dialog';
import { Input } from '../ui/input';
import { Select } from '../ui/select';

type Mode = 'items' | 'equal' | 'merge';

/**
 * Bills part of the order, splits it equally, or merges other open tables of the location into one bill
 * (docs/modules/pos.md → Step 4c–4e, ADR 0036 §4). Each bill prints its checks at once.
 */
export function SplitDialog({
  order,
  locationId,
  onBilled,
}: {
  order: Order;
  locationId: string;
  /** The first check of the new bill, to print; the till reloads the order. */
  onBilled: (checkId: string) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const sent = order.tickets.flatMap((ticket) => ticket.lines.filter((l) => l.quantity > 0));
  const unbilledOf = (lineId: string) => {
    const line = sent.find((l) => l.id === lineId);
    return line ? line.remaining - line.billedQuantity : 0;
  };
  const [mode, setMode] = useState<Mode>('items');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [guests, setGuests] = useState('2');
  const [others, setOthers] = useState<FloorTable[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'merge') return;
    void loadFloor(store, locationId).then((result) => {
      if (result.ok) {
        setOthers(
          result.data.filter(
            (table) => table.order?.status === 'open' && table.order.id !== order.id,
          ),
        );
      }
    });
  }, [mode, store, locationId, order.id]);

  return (
    <FormDialog
      trigger={t('pos.split.open')}
      triggerVariant="outline"
      testId="split-bill"
      title={t('pos.split.title')}
      onOpen={() => {
        setMode('items');
        setCounts({});
        setGuests('2');
        setChosen([]);
        setProblem(null);
      }}
      submit={() => {
        setProblem(null);
        if (mode === 'items') {
          const items = sent
            .map((l) => ({ orderLineId: l.id, quantity: Number(counts[l.id] ?? '0') }))
            .filter((i) => i.quantity > 0);
          const bad = items.some(
            (i) => !Number.isInteger(i.quantity) || i.quantity > unbilledOf(i.orderLineId),
          );
          if (items.length === 0 || bad) {
            setProblem(t('pos.split.nothing'));
            return null;
          }
          return bill({ orderIds: [order.id], items });
        }
        if (mode === 'equal') {
          const shares = Number(guests);
          if (!Number.isInteger(shares) || shares < 2 || shares > 20) {
            setProblem(t('pos.split.guestsRange'));
            return null;
          }
          return bill({ orderIds: [order.id], shares });
        }
        if (chosen.length === 0) {
          setProblem(t('pos.split.nothing'));
          return null;
        }
        return bill({ orderIds: [order.id, ...chosen] });
      }}
      onDone={() => undefined}
    >
      <Field id={`${id}-mode`} label={t('pos.split.mode')} problem={null}>
        <Select
          id={`${id}-mode`}
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
          data-testid="split-mode"
        >
          <option value="items">{t('pos.split.byItem')}</option>
          <option value="equal">{t('pos.split.equally')}</option>
          <option value="merge">{t('pos.split.merge')}</option>
        </Select>
      </Field>

      {mode === 'items' && (
        <div className="flex flex-col gap-2" data-testid="split-items">
          {sent
            .filter((l) => unbilledOf(l.id) > 0)
            .map((l) => (
              <Field
                key={l.id}
                id={`${id}-${l.id}`}
                label={`${l.productName} (${unbilledOf(l.id)})`}
                problem={null}
              >
                <Input
                  id={`${id}-${l.id}`}
                  inputMode="numeric"
                  value={counts[l.id] ?? ''}
                  onChange={(e) => setCounts((c) => ({ ...c, [l.id]: e.target.value }))}
                  data-testid="split-quantity"
                />
              </Field>
            ))}
        </div>
      )}

      {mode === 'equal' && (
        <Field id={`${id}-guests`} label={t('pos.split.guests')} problem={problem}>
          <Input
            id={`${id}-guests`}
            inputMode="numeric"
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
            data-testid="split-guests"
          />
        </Field>
      )}

      {mode === 'merge' && (
        <div className="flex flex-col gap-2" data-testid="split-merge">
          {others.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('pos.split.noOthers')}</p>
          )}
          {others.map((table) => (
            <label key={table.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.includes(table.order!.id)}
                onChange={(e) =>
                  setChosen((list) =>
                    e.target.checked
                      ? [...list, table.order!.id]
                      : list.filter((x) => x !== table.order!.id),
                  )
                }
              />
              {table.name} · {table.order!.number}
            </label>
          ))}
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </div>
      )}
      {mode !== 'equal' && problem && <p className="text-sm text-destructive">{problem}</p>}
    </FormDialog>
  );

  /** Creates the bill; reports the first check or the error (which the dialog shows). */
  function bill(body: Parameters<typeof createBill>[2]) {
    return createBill(store, action, body).then((result) => {
      if (!result.ok) {
        setProblem(t(errorLabel(result.code)));
      } else if (result.data?.checks[0]) {
        onBilled(result.data.checks[0].id);
      }
      return result;
    });
  }
}
