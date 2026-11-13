'use client';

import type { LabelKey } from '@durby/i18n';
import type { Order } from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { addDiscount, removeDiscount } from '../../lib/pos/discounts';
import { useActionKey } from '../../lib/use-action-key';
import { Field, FormDialog } from '../form-dialog';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { useMoney } from './money';

/** The reasons offered (docs/modules/pos.md → Step 4b; the setting `pos.discountReasons` replaces them later). */
const REASONS = ['complaint', 'staffMeal', 'regularGuest', 'promotion', 'comp'] as const;
const REASON_LABEL: Record<(typeof REASONS)[number], LabelKey> = {
  complaint: 'pos.discount.reasons.complaint',
  staffMeal: 'pos.discount.reasons.staffMeal',
  regularGuest: 'pos.discount.reasons.regularGuest',
  promotion: 'pos.discount.reasons.promotion',
  comp: 'pos.discount.reasons.comp',
};

/** A discount on the whole order, or on one sent item still to bill; a comp is 100 % on an item. */
export function DiscountDialog({ order, onDone }: { order: Order; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const lines = order.tickets.flatMap((ticket) =>
    ticket.lines.filter((l) => l.quantity > 0 && l.remaining > 0),
  );
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <FormDialog
      trigger={t('pos.discount.open')}
      triggerVariant="outline"
      testId="give-discount"
      title={t('pos.discount.title')}
      onOpen={() => {
        setTarget('');
        setKind('percent');
        setValue('');
        setReason(REASONS[0]);
        setProblem(null);
      }}
      submit={() => {
        if (!value.trim()) {
          setProblem(t('pos.discount.valueRequired'));
          return null;
        }
        setProblem(null);
        return addDiscount(store, action, order.id, {
          ...(target ? { orderLineId: target } : {}),
          kind,
          value: value.trim(),
          reason: t(REASON_LABEL[reason as (typeof REASONS)[number]]),
        }).then((result) => {
          if (!result.ok) setProblem(t(errorLabel(result.code)));
          return result;
        });
      }}
      onDone={onDone}
    >
      <p className="text-sm text-muted-foreground">{t('pos.discount.description')}</p>
      <Field id={`${id}-target`} label={t('pos.discount.target')} problem={null}>
        <Select
          id={`${id}-target`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          data-testid="discount-target"
        >
          <option value="">{t('pos.discount.wholeOrder')}</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.productName}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`${id}-kind`} label={t('pos.discount.kind')} problem={null}>
        <Select
          id={`${id}-kind`}
          value={kind}
          onChange={(e) => setKind(e.target.value as 'percent' | 'amount')}
        >
          <option value="percent">{t('pos.discount.percent')}</option>
          <option value="amount">{t('pos.discount.amount')}</option>
        </Select>
      </Field>
      <Field id={`${id}-value`} label={t('pos.discount.value')} problem={problem}>
        <Input
          id={`${id}-value`}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="discount-value"
        />
      </Field>
      <Field id={`${id}-reason`} label={t('pos.discount.reason')} problem={null}>
        <Select
          id={`${id}-reason`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="discount-reason"
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(REASON_LABEL[r])}
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}

/** The discounts of the order that stand, each with Remove while nothing of its item is billed. */
export function DiscountList({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const action = useActionKey();
  const [error, setError] = useState<string | null>(null);
  if (order.discounts.length === 0) return null;
  const names = new Map(
    order.tickets.flatMap((ticket) => ticket.lines.map((l) => [l.id, l.productName] as const)),
  );
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="order-discounts">
      <h2 className="text-sm font-semibold">{t('pos.discount.list')}</h2>
      <ul className="flex flex-col gap-1">
        {order.discounts.map((d) => (
          <li
            key={d.id}
            className="flex items-center justify-between gap-2 text-sm"
            data-testid="order-discount"
          >
            <span>
              {d.orderLineId ? names.get(d.orderLineId) : t('pos.discount.wholeOrder')} · {d.reason}
            </span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{money(d.amount)}</span>
              <Button
                variant="ghost"
                className="h-8 px-2"
                data-testid="remove-discount"
                onClick={() =>
                  void removeDiscount(store, action, order.id, d.id).then((result) => {
                    if (result.ok) onChanged();
                    else setError(t(errorLabel(result.code)));
                  })
                }
              >
                {t('pos.discount.remove')}
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Card>
  );
}
