'use client';

import type { FloorTable, Order } from '@durby/shared';
import { Combine, ListChecks, Minus, Plus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadFloor } from '../../lib/pos/api';
import { createBill } from '../../lib/pos/bills';
import { equalShare, pickedTotal, sumMoney } from '../../lib/pos/split';
import { useActionKey } from '../../lib/use-action-key';
import { cn } from '../../lib/utils';
import { FormDialog } from '../form-dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { useMoney } from './money';

type Mode = 'items' | 'equal' | 'merge';

const MIN_SHARES = 2;
const MAX_SHARES = 20;
/** One tap for the usual table sizes. */
const QUICK_SHARES = [2, 3, 4, 5, 6];

/**
 * Bills part of the order, splits it equally, or joins other open tables of the location into one bill
 * (docs/modules/pos.md → Step 4c–4e, ADR 0036 §4). Each bill prints its checks at once. Built for a busy till: big
 * choices instead of a menu, steppers instead of typing, and the amount of the bill shown before it is created.
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
  const money = useMoney();
  const { store } = useAuth();
  const action = useActionKey();
  const lines = order.tickets
    .flatMap((ticket) => ticket.lines.filter((l) => l.quantity > 0))
    .map((l) => ({ ...l, left: l.remaining - l.billedQuantity }))
    .filter((l) => l.left > 0);
  const startShares = Math.min(MAX_SHARES, Math.max(MIN_SHARES, order.covers ?? MIN_SHARES));
  const [mode, setMode] = useState<Mode>('items');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [shares, setShares] = useState(startShares);
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

  const picked = pickedTotal(lines, counts);
  const share = equalShare(order.unbilled, shares);
  const joined = sumMoney([
    order.unbilled,
    ...others.filter((x) => chosen.includes(x.order!.id)).map((x) => x.order!.unbilled),
  ]);
  const setCount = (lineId: string, value: number, left: number) => {
    setProblem(null);
    setCounts((c) => ({ ...c, [lineId]: Math.max(0, Math.min(left, value)) }));
  };

  const submitLabel =
    mode === 'equal'
      ? t('pos.split.createChecks', { count: String(shares) })
      : t('pos.split.createBill');

  return (
    <FormDialog
      trigger={t('pos.split.open')}
      triggerVariant="outline"
      testId="split-bill"
      title={t('pos.split.title')}
      submitLabel={submitLabel}
      wide
      onOpen={() => {
        setMode('items');
        setCounts({});
        setShares(startShares);
        setChosen([]);
        setProblem(null);
      }}
      submit={() => {
        setProblem(null);
        if (mode === 'items') {
          const items = lines
            .map((l) => ({ orderLineId: l.id, quantity: counts[l.id] ?? 0 }))
            .filter((i) => i.quantity > 0);
          if (items.length === 0) {
            setProblem(t('pos.split.pickItems'));
            return null;
          }
          return bill({ orderIds: [order.id], items });
        }
        if (mode === 'equal') return bill({ orderIds: [order.id], shares });
        if (chosen.length === 0) {
          setProblem(t('pos.split.pickTables'));
          return null;
        }
        return bill({ orderIds: [order.id, ...chosen] });
      }}
      onDone={() => undefined}
    >
      {/* The three ways, as big choices: what each does is on the button. */}
      <div
        role="radiogroup"
        aria-label={t('pos.split.mode')}
        className="grid grid-cols-3 gap-2"
        data-testid="split-mode"
      >
        {(
          [
            ['items', ListChecks, 'pos.split.byItem', 'pos.split.byItemHint'],
            ['equal', Users, 'pos.split.equally', 'pos.split.equallyHint'],
            ['merge', Combine, 'pos.split.merge', 'pos.split.mergeHint'],
          ] as const
        ).map(([value, Icon, label, hint]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => {
              setMode(value);
              setProblem(null);
            }}
            className={cn(
              'flex min-h-20 flex-col items-center justify-center gap-1 rounded-lg border p-2 text-center transition-colors',
              mode === value
                ? 'border-primary bg-accent text-foreground'
                : 'bg-card text-muted-foreground hover:bg-muted',
            )}
            data-testid={`split-mode-${value}`}
          >
            <Icon aria-hidden className="size-5" />
            <span className="text-sm font-medium text-foreground">{t(label)}</span>
            <span className="hidden text-xs sm:block">{t(hint)}</span>
          </button>
        ))}
      </div>

      {mode === 'items' && (
        <div className="flex flex-col gap-2" data-testid="split-items">
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCounts(Object.fromEntries(lines.map((l) => [l.id, l.left])))}
              data-testid="split-all"
            >
              {t('pos.split.selectAll')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCounts({})}
              data-testid="split-clear"
            >
              {t('pos.split.clear')}
            </Button>
          </div>
          <ul className="flex max-h-[45vh] flex-col divide-y overflow-y-auto rounded-lg border">
            {lines.map((line) => {
              const count = counts[line.id] ?? 0;
              return (
                <li
                  key={line.id}
                  className={cn('flex items-center gap-3 px-3 py-2', count > 0 && 'bg-accent/60')}
                  data-testid="split-line"
                  data-name={line.productName}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{line.productName}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t('pos.split.lineInfo', {
                        price: money(line.unitPrice),
                        left: String(line.left),
                      })}
                    </span>
                  </span>
                  <span className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      className="size-11 px-0"
                      disabled={count === 0}
                      aria-label={t('pos.split.less', { name: line.productName })}
                      onClick={() => setCount(line.id, count - 1, line.left)}
                    >
                      <Minus aria-hidden />
                    </Button>
                    <span
                      className="w-8 text-center text-lg font-semibold tabular-nums"
                      aria-live="polite"
                      data-testid="split-quantity"
                    >
                      {count}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="size-11 px-0"
                      disabled={count >= line.left}
                      aria-label={t('pos.split.more', { name: line.productName })}
                      onClick={() => setCount(line.id, count + 1, line.left)}
                      data-testid="split-more"
                    >
                      <Plus aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11"
                      disabled={count === line.left}
                      onClick={() => setCount(line.id, line.left, line.left)}
                    >
                      {t('pos.split.allOf')}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
          <p
            className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm"
            data-testid="split-summary"
          >
            <span>{t('pos.split.itemsPicked', { count: String(picked.items) })}</span>
            <span className="text-base font-semibold tabular-nums">{money(picked.gross)}</span>
          </p>
        </div>
      )}

      {mode === 'equal' && (
        <div className="flex flex-col gap-3" data-testid="split-equal">
          <p className="text-sm font-medium">{t('pos.split.guests')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_SHARES.map((n) => (
              <Button
                key={n}
                type="button"
                variant={shares === n ? 'default' : 'outline'}
                className="size-12 text-lg"
                aria-pressed={shares === n}
                onClick={() => setShares(n)}
                data-testid="split-guests-quick"
              >
                {n}
              </Button>
            ))}
            <span className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                className="size-11 px-0"
                disabled={shares <= MIN_SHARES}
                aria-label={t('pos.split.fewerGuests')}
                onClick={() => setShares((s) => Math.max(MIN_SHARES, s - 1))}
              >
                <Minus aria-hidden />
              </Button>
              <span
                className="w-10 text-center text-xl font-semibold tabular-nums"
                aria-live="polite"
                data-testid="split-guests"
              >
                {shares}
              </span>
              <Button
                type="button"
                variant="outline"
                className="size-11 px-0"
                disabled={shares >= MAX_SHARES}
                aria-label={t('pos.split.moreGuests')}
                onClick={() => setShares((s) => Math.min(MAX_SHARES, s + 1))}
              >
                <Plus aria-hidden />
              </Button>
            </span>
          </div>
          <div className="rounded-lg bg-muted px-3 py-3 text-center" data-testid="split-each">
            <p className="text-2xl font-semibold tabular-nums">
              {t('pos.split.each', { amount: money(share.each) })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('pos.split.ofTotal', { count: String(shares), total: money(order.unbilled) })}
              {share.uneven && ` ${t('pos.split.centMore')}`}
            </p>
          </div>
        </div>
      )}

      {mode === 'merge' && (
        <div className="flex flex-col gap-2" data-testid="split-merge">
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('pos.split.noOthers')}</p>
          ) : (
            <ul className="flex max-h-[45vh] flex-col divide-y overflow-y-auto rounded-lg border">
              {others.map((table) => {
                const orderId = table.order!.id;
                const on = chosen.includes(orderId);
                return (
                  <li key={table.id}>
                    <label
                      className={cn(
                        'flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2',
                        on && 'bg-accent/60',
                      )}
                    >
                      <Checkbox
                        checked={on}
                        onCheckedChange={(next) => {
                          setProblem(null);
                          setChosen((list) =>
                            next === true ? [...list, orderId] : list.filter((x) => x !== orderId),
                          );
                        }}
                        data-testid="split-merge-table"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium">{table.name}</span>
                        <span className="text-xs text-muted-foreground">{table.order!.number}</span>
                      </span>
                      <span className="tabular-nums">{money(table.order!.unbilled)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <p
            className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm"
            data-testid="split-summary"
          >
            <span>{t('pos.split.joinedTotal', { count: String(chosen.length + 1) })}</span>
            <span className="text-base font-semibold tabular-nums">{money(joined)}</span>
          </p>
        </div>
      )}

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </FormDialog>
  );

  /** Creates the bill and reports its first check; FormDialog shows an error itself. */
  function bill(body: Parameters<typeof createBill>[2]) {
    return createBill(store, action, body).then((result) => {
      if (result.ok && result.data?.checks[0]) onBilled(result.data.checks[0].id);
      return result;
    });
  }
}
