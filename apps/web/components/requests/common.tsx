'use client';

import {
  pickedQuantitySchema,
  type StockUnit,
  type StockRequest,
  type StockRequestStatus,
  type StockRequestSummary,
} from '@durby/shared';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import type { Result } from '../../lib/api-call';
import { compareQuantity } from '../../lib/orders/form';
import { exceedsStock, shownStock } from '../../lib/orders/shortage';
import { cn } from '../../lib/utils';
import { FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';

/** `in_transit` → `inTransit`: label keys are camelCase. */
export const statusKey = (status: StockRequestStatus) =>
  status.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as
    Exclude<StockRequestStatus, 'in_transit'> | 'inTransit';

/** Theme tokens only: waiting stands out, on the way outlined, done and rejected recede. */
const TONE: Record<StockRequestStatus, string> = {
  submitted: 'border-primary text-primary',
  approved: 'border-primary text-primary',
  picking: 'border-foreground/40 text-foreground',
  packed: 'border-foreground/40 text-foreground',
  in_transit: 'border-foreground/40 text-foreground',
  delivered: 'border-foreground/40 text-foreground',
  received: 'border-transparent bg-muted text-foreground',
  rejected: 'line-through',
  cancelled: 'line-through',
};

export function RequestStatusBadge({ status }: { status: StockRequestStatus }) {
  const t = useT();
  return (
    <Badge className={cn('uppercase', TONE[status])} data-testid="request-status">
      {t(`orders.requestStatus.${statusKey(status)}`)}
    </Badge>
  );
}

/** "3.000" → "3", "1.500" → "1.5". */
export const shortQuantity = (q: string) => q.replace(/\.?0+$/, '') || '0';

/** One line of a request as the cards and dialogs show it. */
export function requestTitle(r: Pick<StockRequestSummary, 'number' | 'transferNumber'>) {
  return r.transferNumber ?? r.number;
}

export interface QuantityLine {
  id: string;
  name: string;
  unit: StockUnit;
  /** Shown beside the input (requested, approved, packed). */
  reference: string;
  /** What the line may be at most (null: no cap). */
  max: string | null;
  /** The value the input starts with. */
  initial: string;
  /** What is in stock where it comes from (picking); absent: not shown. */
  available?: string;
  /** How much of `reference` isn't in stock (picking); null or absent: nothing. */
  short?: string | null;
}

/**
 * A dialog that asks a quantity per line (approve, pack, receive): 3 decimals, 0 allowed, at most `max`. `run` gets
 * every line's quantity. With `available` (picking) it shows what is in stock, marks lines short of stock and names
 * those asked for beyond it, so a shortage is plain before the api refuses to book below zero.
 */
export function QuantitiesDialog({
  trigger,
  triggerVariant = 'default',
  testId,
  title,
  hint,
  submitLabel,
  referenceLabel,
  inputLabel,
  lines,
  run,
  onDone,
  onOpen,
  availableLabel,
  quantityLabel,
  children,
}: {
  trigger: string;
  triggerVariant?: 'default' | 'outline';
  testId: string;
  title: string;
  hint: string;
  submitLabel: string;
  /** The column of `reference`, e.g. "Approved". */
  referenceLabel: string;
  inputLabel: (name: string) => string;
  lines: readonly QuantityLine[];
  run: (quantities: { lineId: string; quantity: string }[]) => Promise<Result<unknown>>;
  onDone: () => void;
  /** Each time the dialog opens, e.g. to read the stock again. */
  onOpen?: () => void;
  /** The column of `available`, e.g. "In stock". */
  availableLabel?: string;
  /** The heading of the quantities typed, e.g. "To send"; without it the column has none on screen. */
  quantityLabel?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const valueOf = (line: QuantityLine) => (values[line.id] ?? line.initial).trim();
  const withStock = lines.some((line) => line.available !== undefined);
  const short = lines.filter((line) => line.short);
  // Asked for beyond what is in stock: the api refuses that unless the location allows negative stock.
  const beyond = lines.filter(
    (line) => line.available !== undefined && exceedsStock(valueOf(line), line.available),
  );
  const stockList = (list: readonly QuantityLine[]) =>
    list
      .map((line) =>
        t('orders.transfers.itemInStock', {
          name: line.name,
          quantity: `${shownStock(line.available ?? '0')} ${t(`inventory.units.${line.unit}`)}`,
        }),
      )
      .join(', ');
  const valid = lines.every((line) => {
    const v = valueOf(line);
    return (
      pickedQuantitySchema.safeParse(v).success &&
      (line.max === null || (compareQuantity(v, line.max) ?? 1) <= 0)
    );
  });
  return (
    <FormDialog
      trigger={trigger}
      triggerVariant={triggerVariant}
      testId={testId}
      title={title}
      submitLabel={submitLabel}
      wide
      onOpen={() => {
        setValues({});
        setChecked(false);
        onOpen?.();
      }}
      submit={() => {
        setChecked(true);
        if (!valid) return null;
        return run(lines.map((line) => ({ lineId: line.id, quantity: valueOf(line) })));
      }}
      onDone={onDone}
    >
      <p className="text-sm text-muted-foreground">{hint}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid={`${testId}-lines`}>
          <thead>
            <tr className="border-b text-left text-xs tracking-wide text-muted-foreground uppercase">
              <th className="py-2 pr-2 font-medium">{t('orders.requestForm.item')}</th>
              <th className="w-24 px-2 py-2 text-right font-medium whitespace-nowrap">
                {referenceLabel}
              </th>
              {withStock && (
                <th className="w-24 px-2 py-2 text-right font-medium whitespace-nowrap">
                  {availableLabel}
                </th>
              )}
              <th className="w-28 py-2 pl-2 text-right font-medium whitespace-nowrap">
                {quantityLabel ?? <span className="sr-only">{submitLabel}</span>}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.id}
                className="border-b align-middle last:border-0"
                data-testid={`${testId}-line`}
              >
                <td className="py-2 pr-2">
                  <span className="flex flex-wrap items-center gap-2">
                    {line.name}
                    {line.short && (
                      <Badge
                        className="bg-accent text-accent-foreground"
                        data-testid={`${testId}-short`}
                      >
                        {t('orders.transfers.short', {
                          quantity: `${line.short} ${t(`inventory.units.${line.unit}`)}`,
                        })}
                      </Badge>
                    )}
                  </span>
                </td>
                <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">
                  {`${shortQuantity(line.reference)} ${t(`inventory.units.${line.unit}`)}`}
                </td>
                {withStock && (
                  <td
                    className={cn(
                      'px-2 py-2 text-right whitespace-nowrap tabular-nums',
                      line.short && 'font-medium text-destructive',
                    )}
                    data-testid={`${testId}-available`}
                  >
                    {line.available === undefined
                      ? ''
                      : `${shownStock(line.available)} ${t(`inventory.units.${line.unit}`)}`}
                  </td>
                )}
                <td className="py-2 pl-2 text-right">
                  <Input
                    id={`${id}-${line.id}`}
                    inputMode="decimal"
                    className="ml-auto w-24 text-right"
                    value={values[line.id] ?? line.initial}
                    aria-label={inputLabel(line.name)}
                    aria-invalid={beyond.includes(line) || undefined}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [line.id]: e.target.value.replace(',', '.') }))
                    }
                    data-testid={`${testId}-quantity`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {short.length > 0 && beyond.length === 0 && (
        <p className="rounded-md bg-accent px-3 py-2 text-sm" data-testid={`${testId}-shortage`}>
          {t('orders.transfers.shortageNote', { items: stockList(short) })}
        </p>
      )}
      {beyond.length > 0 && (
        <p role="alert" className="text-sm text-destructive" data-testid={`${testId}-beyond`}>
          {t('orders.transfers.beyondStock', { items: stockList(beyond) })}
        </p>
      )}
      {checked && !valid && (
        <p role="alert" className="text-sm text-destructive">
          {t('orders.requestsPage.invalid')}
        </p>
      )}
      {children}
    </FormDialog>
  );
}

/** The quantities of a request, step by step, and its timeline. */
export function RequestFacts({
  request,
  formatTime,
}: {
  request: StockRequest;
  formatTime: (iso: string) => string;
}) {
  const t = useT();
  const q = (v: string | null) => (v === null ? '–' : shortQuantity(v));
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t('orders.requestsPage.route', {
          from: `${request.fromLocationName} · ${request.fromWarehouseName}`,
          to: `${request.locationName} · ${request.toWarehouseName}`,
        })}
        {request.transferNumber && (
          <>
            <br />
            {t('orders.requestsPage.transfer', { number: request.transferNumber })} ·{' '}
            {request.driverName
              ? t('orders.requestsPage.driver', { name: request.driverName })
              : t('orders.requestsPage.noDriver')}
          </>
        )}
      </p>
      {request.note && (
        <p className="text-sm">
          <span className="text-muted-foreground">{t('orders.requestsPage.note')}: </span>
          {request.note}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="request-lines">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 font-medium">{t('orders.requestForm.item')}</th>
              <th className="py-1 text-right font-medium">{t('orders.requestsPage.requested')}</th>
              <th className="py-1 text-right font-medium">{t('orders.requestsPage.approved')}</th>
              <th className="py-1 text-right font-medium">{t('orders.requestsPage.picked')}</th>
              <th className="py-1 text-right font-medium">{t('orders.requestsPage.received')}</th>
            </tr>
          </thead>
          <tbody>
            {request.lines.map((line) => (
              <tr key={line.id} className="border-b last:border-0" data-testid="request-line">
                <td className="py-1.5">
                  <span className="flex flex-wrap items-center gap-2">
                    {line.itemName}
                    {/* Not requested: the warehouse sent it along (item 9). */}
                    {line.addedAtPacking && (
                      <Badge data-testid="request-line-extra">
                        {t('orders.requestsPage.addedAtPacking')}
                      </Badge>
                    )}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {line.addedAtPacking ? '–' : `${q(line.quantity)} ${line.unit}`}
                </td>
                <td className="py-1.5 text-right tabular-nums">{q(line.approvedQuantity)}</td>
                <td className="py-1.5 text-right tabular-nums">{q(line.pickedQuantity)}</td>
                <td className="py-1.5 text-right tabular-nums">{q(line.receivedQuantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="flex flex-col gap-2" aria-label={t('orders.requestsPage.timeline')}>
        <h3 className="font-medium">{t('orders.requestsPage.timeline')}</h3>
        <ol className="flex flex-col gap-2 border-l pl-4" data-testid="request-timeline">
          {request.events.map((event) => (
            <li key={event.id} className="relative text-sm">
              <span
                aria-hidden
                className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-primary"
              />
              <span className="font-medium">
                {t(`orders.requestStatus.${statusKey(event.status)}`)}
              </span>
              <span className="text-muted-foreground"> · {formatTime(event.createdAt)}</span>
              {event.note && <p className="text-muted-foreground">{event.note}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** A short note dialog (reject, cancel, delivered). */
export function NoteDialog({
  trigger,
  triggerVariant = 'outline',
  testId,
  title,
  label,
  submitLabel,
  run,
  onDone,
}: {
  trigger: string;
  triggerVariant?: 'default' | 'outline';
  testId: string;
  title: string;
  label: string;
  submitLabel: string;
  run: (note: string | undefined) => Promise<Result<unknown>>;
  onDone: () => void;
}) {
  const id = useId();
  const [note, setNote] = useState('');
  return (
    <FormDialog
      trigger={trigger}
      triggerVariant={triggerVariant}
      testId={testId}
      title={title}
      submitLabel={submitLabel}
      onOpen={() => setNote('')}
      submit={() => run(note.trim() || undefined)}
      onDone={onDone}
    >
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-note`} className="text-sm font-medium">
          {label}
        </label>
        <Input
          id={`${id}-note`}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          data-testid={`${testId}-note`}
        />
      </div>
    </FormDialog>
  );
}
