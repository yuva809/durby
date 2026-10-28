'use client';

import type { Order, SendTicketResponse } from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { voidLines } from '../../lib/pos/api';
import { useActionKey } from '../../lib/use-action-key';
import { Field, FormDialog } from '../form-dialog';
import { Input } from '../ui/input';

/** Choose how many of each sent item to void; the caller prints the VOID ticket. */
export function VoidDialog({
  order,
  onVoided,
}: {
  order: Order;
  onVoided: (response: SendTicketResponse) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const lines = order.tickets.flatMap((ticket) => ticket.lines.filter((l) => l.remaining > 0));
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <FormDialog
      trigger={t('pos.order.void')}
      triggerVariant="outline"
      testId="void-items"
      title={t('pos.order.voidTitle')}
      onOpen={() => {
        setCounts({});
        setProblem(null);
      }}
      submit={() => {
        const chosen = lines
          .map((line) => ({ lineId: line.id, quantity: Number(counts[line.id] ?? '0') }))
          .filter((l) => l.quantity > 0);
        const invalid = lines.some((line) => {
          const n = Number(counts[line.id] ?? '0');
          return !Number.isInteger(n) || n < 0 || n > line.remaining;
        });
        if (chosen.length === 0 || invalid) {
          setProblem(t('pos.order.voidNothing'));
          return null;
        }
        setProblem(null);
        return voidLines(store, action, order.id, { lines: chosen }).then((result) => {
          if (result.ok && result.data) onVoided(result.data);
          return result;
        });
      }}
      onDone={() => undefined}
    >
      <p className="text-sm text-muted-foreground">{t('pos.order.voidDescription')}</p>
      {lines.map((line) => (
        <Field
          key={line.id}
          id={`${id}-${line.id}`}
          label={t('pos.order.lineQuantity', {
            quantity: String(line.remaining),
            name: line.productName,
          })}
          problem={null}
        >
          <Input
            id={`${id}-${line.id}`}
            inputMode="numeric"
            aria-label={t('pos.order.voidQuantity', { name: line.productName })}
            value={counts[line.id] ?? ''}
            onChange={(e) => setCounts((c) => ({ ...c, [line.id]: e.target.value }))}
          />
        </Field>
      ))}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </FormDialog>
  );
}
