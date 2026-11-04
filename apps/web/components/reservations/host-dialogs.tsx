'use client';

import type {
  CreateReservationRequest,
  LocalDate,
  Reservation,
  ReservationsFloorTable,
} from '@durby/shared';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { ApiErrorCode } from '../../lib/auth/errors';
import { errorLabel } from '../../lib/auth/errors';
import type { Result } from '../../lib/api-call';
import {
  clockTime,
  createBooking,
  createWalkIn,
  instantAt,
  runAction,
  seatUntil,
  updateBooking,
} from '../../lib/reservations/host';
import { useActionKey } from '../../lib/use-action-key';
import { Field } from '../form-dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

type Failure = ApiErrorCode | 'unknown';

/** A controlled dialog with a form: `onSubmit` runs the write and returns its failure, if any. */
function HostDialog({
  open,
  onOpenChange,
  title,
  testId,
  submitLabel,
  busy,
  error,
  extra,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  testId: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  /** A second way out of an error, e.g. "Book anyway". */
  extra?: ReactNode;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={t('platform.common.close')}
        aria-describedby={undefined}
        data-testid={testId}
      >
        <DialogTitle>{title}</DialogTitle>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {children}
          <Notice text={error} tone="error" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('platform.common.cancel')}
            </Button>
            {extra}
            <Button type="submit" disabled={busy} data-testid={`${testId}-submit`}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Checkboxes for the tables in service (walk-in-only ones only when `walkIns`). */
function TablePicker({
  tables,
  selected,
  onChange,
  walkIns,
  legend,
}: {
  tables: readonly ReservationsFloorTable[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  walkIns: boolean;
  legend: string;
}) {
  const t = useT();
  const id = useId();
  const shown = tables.filter((x) => walkIns || !x.walkInOnly);
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((table) => (
          <div key={table.id} className="flex items-center gap-2">
            <Checkbox
              id={`${id}-${table.id}`}
              checked={selected.includes(table.id)}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? [...selected, table.id]
                    : selected.filter((x) => x !== table.id),
                )
              }
            />
            <Label htmlFor={`${id}-${table.id}`} className="font-normal">
              {t('reservations.host.tableOption', { name: table.name, seats: String(table.seats) })}
            </Label>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

const partyOk = (n: number) => Number.isInteger(n) && n >= 1 && n <= 100;
const trimmed = (s: string) => (s.trim() === '' ? undefined : s.trim());

/** + Booking: a phone booking (docs/modules/reservations.md → Web, R1.8b). */
export function BookingDialog({
  open,
  onOpenChange,
  locationId,
  timeZone,
  date,
  time,
  tables,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: string;
  timeZone: string;
  date: LocalDate;
  time: string;
  tables: readonly ReservationsFloorTable[];
  onDone: (booking: Reservation) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [form, setForm] = useState({
    date,
    time,
    party: '2',
    name: '',
    phone: '',
    guestNote: '',
    staffNote: '',
  });
  const [tableIds, setTableIds] = useState<string[]>([]);
  const [problems, setProblems] = useState<{ time?: string; party?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function submit(force: boolean) {
    const party = Number(form.party);
    const startsAt = instantAt(form.date, form.time, timeZone);
    const found = {
      ...(startsAt === null && { time: t('reservations.host.booking.timeInvalid') }),
      ...(!partyOk(party) && { party: t('reservations.host.partyInvalid') }),
    };
    setProblems(found);
    if (startsAt === null || !partyOk(party)) return;
    const body: CreateReservationRequest = {
      locationId,
      startsAt,
      partySize: party,
      ...(tableIds.length > 0 && { tableIds }),
      guest: { name: trimmed(form.name), phone: trimmed(form.phone) },
      guestNote: trimmed(form.guestNote),
      staffNote: trimmed(form.staffNote),
      ...(force && { force: true }),
    };
    setBusy(true);
    setFailure(null);
    const result = await createBooking(store, action, body);
    setBusy(false);
    if (result.ok && result.data) {
      onOpenChange(false);
      onDone(result.data);
    } else {
      setFailure(result.ok ? 'unknown' : result.code);
    }
  }

  // Pacing and reservation hours are rules staff may override (Q2): offer it after the refusal.
  const overridable =
    failure === 'reservations.pacing_exceeded' || failure === 'reservations.outside_service_hours';
  return (
    <HostDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('reservations.host.booking.title')}
      testId="booking-dialog"
      submitLabel={t('reservations.host.booking.submit')}
      busy={busy}
      error={failure ? t(errorLabel(failure)) : null}
      extra={
        overridable && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="booking-force"
            onClick={() => void submit(true)}
          >
            {t('reservations.host.booking.force')}
          </Button>
        )
      }
      onSubmit={() => void submit(false)}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field id={`${id}-date`} label={t('reservations.host.booking.date')} problem={null}>
          <Input id={`${id}-date`} type="date" value={form.date} onChange={set('date')} required />
        </Field>
        <Field
          id={`${id}-time`}
          label={t('reservations.host.booking.time')}
          problem={problems.time ?? null}
        >
          <Input
            id={`${id}-time`}
            type="time"
            step={300}
            value={form.time}
            onChange={set('time')}
          />
        </Field>
        <Field
          id={`${id}-party`}
          label={t('reservations.host.party')}
          problem={problems.party ?? null}
        >
          <Input
            id={`${id}-party`}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={form.party}
            onChange={set('party')}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-name`} label={t('reservations.host.guestName')} problem={null}>
          <Input id={`${id}-name`} autoComplete="off" value={form.name} onChange={set('name')} />
        </Field>
        <Field id={`${id}-phone`} label={t('reservations.host.phone')} problem={null}>
          <Input
            id={`${id}-phone`}
            type="tel"
            autoComplete="off"
            value={form.phone}
            onChange={set('phone')}
          />
        </Field>
      </div>
      <Field
        id={`${id}-guest-note`}
        label={t('reservations.host.booking.guestNote')}
        problem={null}
      >
        <Input id={`${id}-guest-note`} value={form.guestNote} onChange={set('guestNote')} />
      </Field>
      <Field
        id={`${id}-staff-note`}
        label={t('reservations.host.booking.staffNote')}
        problem={null}
      >
        <Input id={`${id}-staff-note`} value={form.staffNote} onChange={set('staffNote')} />
      </Field>
      <TablePicker
        tables={tables}
        selected={tableIds}
        onChange={setTableIds}
        walkIns={false}
        legend={t('reservations.host.booking.tables')}
      />
      <p className="text-sm text-muted-foreground">{t('reservations.host.booking.tablesHint')}</p>
    </HostDialog>
  );
}

/** + Walk-in, or "Seat walk-in" on a free table: seated now (R1.6c). */
export function WalkInDialog({
  open,
  onOpenChange,
  locationId,
  timeZone,
  tables,
  initialTableIds,
  now,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: string;
  timeZone: string;
  tables: readonly ReservationsFloorTable[];
  initialTableIds: readonly string[];
  now: number;
  onDone: (booking: Reservation) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [party, setParty] = useState('2');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [tableIds, setTableIds] = useState<string[]>([...initialTableIds]);
  const [problems, setProblems] = useState<{ party?: string; tables?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  // A walk-in that runs into the tables' next booking may sit until then (api: endsAt).
  const until =
    failure === 'reservations.table_unavailable' ? seatUntil(tableIds, tables, now) : null;

  async function submit(endsAt: string | null) {
    const size = Number(party);
    const found = {
      ...(!partyOk(size) && { party: t('reservations.host.partyInvalid') }),
      ...(tableIds.length === 0 && { tables: t('reservations.host.walkIn.tablesRequired') }),
    };
    setProblems(found);
    if (!partyOk(size) || tableIds.length === 0) return;
    setBusy(true);
    setFailure(null);
    const result = await createWalkIn(store, action, {
      locationId,
      partySize: size,
      tableIds,
      ...(trimmed(name) && { name: trimmed(name) }),
      ...(trimmed(phone) && { phone: trimmed(phone) }),
      ...(endsAt && { endsAt }),
    });
    setBusy(false);
    if (result.ok && result.data) {
      onOpenChange(false);
      onDone(result.data);
    } else {
      setFailure(result.ok ? 'unknown' : result.code);
    }
  }

  return (
    <HostDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('reservations.host.walkIn.title')}
      testId="walk-in-dialog"
      submitLabel={t('reservations.host.walkIn.submit')}
      busy={busy}
      error={failure ? t(errorLabel(failure)) : null}
      extra={
        until && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="walk-in-until"
            onClick={() => void submit(until)}
          >
            {t('reservations.host.walkIn.until', { time: clockTime(until, timeZone) })}
          </Button>
        )
      }
      onSubmit={() => void submit(null)}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          id={`${id}-party`}
          label={t('reservations.host.party')}
          problem={problems.party ?? null}
        >
          <Input
            id={`${id}-party`}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={party}
            onChange={(e) => setParty(e.target.value)}
          />
        </Field>
        <Field id={`${id}-name`} label={t('reservations.host.guestName')} problem={null}>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id={`${id}-phone`} label={t('reservations.host.phone')} problem={null}>
          <Input
            id={`${id}-phone`}
            type="tel"
            autoComplete="off"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
      </div>
      <TablePicker
        tables={tables}
        selected={tableIds}
        onChange={setTableIds}
        walkIns
        legend={t('reservations.host.walkIn.tables')}
      />
      {problems.tables && (
        <p role="alert" className="text-sm text-destructive">
          {problems.tables}
        </p>
      )}
    </HostDialog>
  );
}

/**
 * Change tables: move a booking (PATCH tableIds), e.g. off a table pos archived, or seat it at other
 * tables (Seat with tableIds) when its own can't take it.
 */
export function TablesDialog({
  open,
  onOpenChange,
  booking,
  mode,
  tables,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking: Reservation;
  mode: 'move' | 'seat';
  tables: readonly ReservationsFloorTable[];
  onDone: (booking: Reservation) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const inService = new Set(tables.map((x) => x.id));
  const [tableIds, setTableIds] = useState(booking.tableIds.filter((x) => inService.has(x)));
  const [failure, setFailure] = useState<Failure | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (tableIds.length === 0) {
      setProblem(t('reservations.host.walkIn.tablesRequired'));
      return;
    }
    setProblem(null);
    setBusy(true);
    setFailure(null);
    const result: Result<Reservation | null> =
      mode === 'seat'
        ? await runAction(store, action, booking.id, 'seat', { tableIds })
        : await updateBooking(store, action, booking.id, { tableIds });
    setBusy(false);
    if (result.ok && result.data) {
      onOpenChange(false);
      onDone(result.data);
    } else {
      setFailure(result.ok ? 'unknown' : result.code);
    }
  }

  return (
    <HostDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(
        mode === 'seat'
          ? 'reservations.host.tables.seatTitle'
          : 'reservations.host.tables.moveTitle',
        {
          guest: booking.guest.name ?? t('reservations.host.noName'),
        },
      )}
      testId="tables-dialog"
      submitLabel={t(mode === 'seat' ? 'reservations.host.actions.seat' : 'platform.common.save')}
      busy={busy}
      error={failure ? t(errorLabel(failure)) : null}
      onSubmit={() => void submit()}
    >
      <TablePicker
        tables={tables}
        selected={tableIds}
        onChange={setTableIds}
        walkIns={booking.source === 'walk_in'}
        legend={t('reservations.host.tables.legend')}
      />
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </HostDialog>
  );
}
