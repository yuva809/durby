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
  anonymiseGuest,
  bookingChanges,
  clockTime,
  createBooking,
  createWalkIn,
  freeSlots,
  instantAt,
  loadAvailability,
  localDate,
  runAction,
  seatUntil,
  updateBooking,
} from '../../lib/reservations/host';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { Field } from '../form-dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { ConfirmAction } from '../users/common';

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

/**
 * + Booking (a phone booking, R1.8b) or, with `booking`, its edit (R1.9): date, party, the day's
 * free times (the engine's table for each) or a typed time, tables chosen by hand if wanted, guest
 * and notes. Pacing and reservation hours refusals offer "Book anyway". With `canErase` an edit can
 * erase the guest's personal data (GDPR, confirm first).
 */
export function BookingDialog({
  open,
  onOpenChange,
  locationId,
  timeZone,
  date,
  time,
  tables,
  booking,
  canErase = false,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: string;
  timeZone: string;
  date: LocalDate;
  time: string;
  tables: readonly ReservationsFloorTable[];
  /** Edit this booking instead of creating one. */
  booking?: Reservation;
  /** reservations.setup.delete: the edit offers "Erase guest data". */
  canErase?: boolean;
  /** The saved booking; null after the guest's data was erased. */
  onDone: (booking: Reservation | null) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const eraseAction = useActionKey();
  const id = useId();
  const editing = booking !== undefined;
  const erased = booking?.guest.anonymisedAt != null;
  const [form, setForm] = useState(() =>
    booking
      ? {
          date: localDate(Date.parse(booking.startsAt), timeZone),
          time: clockTime(booking.startsAt, timeZone),
          party: String(booking.partySize),
          name: booking.guest.name ?? '',
          phone: booking.guest.phone ?? '',
          email: booking.guest.email ?? '',
          guestNote: booking.guestNote ?? '',
          staffNote: booking.staffNote ?? '',
        }
      : {
          date,
          time,
          party: '2',
          name: '',
          phone: '',
          email: '',
          guestNote: '',
          staffNote: '',
        },
  );
  const [tableIds, setTableIds] = useState<string[]>(booking ? [...booking.tableIds] : []);
  const [choosing, setChoosing] = useState(false);
  const [problems, setProblems] = useState<{ time?: string; party?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const party = Number(form.party);
  const [availability] = useResource(
    partyOk(party) && form.date ? `${locationId}|${form.date}|${party}|${booking?.id ?? ''}` : null,
    () => loadAvailability(store, locationId, form.date, party, booking?.id),
  );
  const slots = availability.status === 'ready' ? freeSlots(availability.data.slots) : null;
  const names = new Map(tables.map((x) => [x.id, x.name]));

  async function submit(force: boolean) {
    const startsAt = instantAt(form.date, form.time, timeZone);
    const found = {
      ...(startsAt === null && { time: t('reservations.host.booking.timeInvalid') }),
      ...(!partyOk(party) && { party: t('reservations.host.partyInvalid') }),
    };
    setProblems(found);
    if (startsAt === null || !partyOk(party)) return;
    let result: Result<Reservation | null>;
    if (booking) {
      const changes = bookingChanges(booking, { ...form, startsAt, partySize: party, tableIds });
      if (!changes) {
        onOpenChange(false);
        return;
      }
      setBusy(true);
      setFailure(null);
      result = await updateBooking(store, action, booking.id, {
        ...changes,
        ...(force && { force: true }),
      });
    } else {
      const body: CreateReservationRequest = {
        locationId,
        startsAt,
        partySize: party,
        ...(tableIds.length > 0 && { tableIds }),
        guest: { name: trimmed(form.name), phone: trimmed(form.phone), email: trimmed(form.email) },
        guestNote: trimmed(form.guestNote),
        staffNote: trimmed(form.staffNote),
        ...(force && { force: true }),
      };
      setBusy(true);
      setFailure(null);
      result = await createBooking(store, action, body);
    }
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
  const guestLabel = booking?.guest.name ?? t('reservations.host.noName');
  return (
    <HostDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        booking
          ? t('reservations.host.booking.editTitle', { number: booking.number })
          : t('reservations.host.booking.title')
      }
      testId="booking-dialog"
      submitLabel={t(editing ? 'platform.common.save' : 'reservations.host.booking.submit')}
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Field id={`${id}-date`} label={t('reservations.host.booking.date')} problem={null}>
          <Input
            id={`${id}-date`}
            type="date"
            className="min-w-0"
            value={form.date}
            onChange={set('date')}
            required
          />
        </Field>
        <Field
          id={`${id}-time`}
          label={t('reservations.host.booking.time')}
          problem={problems.time ?? null}
        >
          <Input
            id={`${id}-time`}
            className="min-w-0"
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

      <fieldset className="flex flex-col gap-2" data-testid="booking-free-times">
        <legend className="mb-1 text-sm font-medium">
          {t('reservations.host.booking.freeTimes')}
        </legend>
        {slots === null ? (
          <p className="text-sm text-muted-foreground">
            {availability.status === 'error'
              ? t('reservations.host.booking.freeTimesFailed')
              : t('reservations.host.booking.freeTimesLoading')}
          </p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('reservations.host.booking.noFreeTimes')}
          </p>
        ) : (
          <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
            {slots.map((slot) => {
              const label = clockTime(slot.start, timeZone);
              const chosen = label === form.time;
              return (
                <Button
                  key={slot.start}
                  type="button"
                  variant={chosen ? 'default' : 'outline'}
                  aria-pressed={chosen}
                  className="min-h-11 tabular-nums"
                  data-testid="booking-slot"
                  onClick={() => {
                    setForm((f) => ({ ...f, time: label }));
                    setTableIds(slot.tableIds);
                  }}
                >
                  {label}
                </Button>
              );
            })}
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm" data-testid="booking-tables-summary">
          {tableIds.length > 0
            ? t('reservations.host.booking.chosenTables', {
                tables: tableIds
                  .map((x) => names.get(x) ?? t('reservations.host.tableGone'))
                  .join(' + '),
              })
            : t('reservations.host.booking.engineTables')}
        </p>
        {!choosing && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            data-testid="booking-choose-tables"
            onClick={() => setChoosing(true)}
          >
            {t('reservations.host.booking.chooseTables')}
          </Button>
        )}
      </div>
      {choosing && (
        <TablePicker
          tables={tables}
          selected={tableIds}
          onChange={setTableIds}
          walkIns={booking?.source === 'walk_in'}
          legend={t('reservations.host.booking.tables')}
        />
      )}

      {erased && (
        <p className="rounded-md bg-accent px-3 py-2 text-sm" data-testid="booking-erased">
          {t('reservations.guest.erasedHint')}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
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
        <Field id={`${id}-email`} label={t('reservations.host.email')} problem={null}>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="off"
            value={form.email}
            onChange={set('email')}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
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
      </div>

      {booking && canErase && !erased && (
        <div className="flex flex-col gap-2 border-t pt-4">
          <p className="text-sm text-muted-foreground">{t('reservations.guest.eraseHint')}</p>
          <div>
            <ConfirmAction
              trigger={t('reservations.guest.erase')}
              title={t('reservations.guest.eraseTitle', { guest: guestLabel })}
              description={t('reservations.guest.eraseDescription')}
              confirm={t('reservations.guest.erase')}
              testId="booking-erase"
              run={() => anonymiseGuest(store, eraseAction, booking.guest.id)}
              onDone={() => {
                onOpenChange(false);
                onDone(null);
              }}
            />
          </div>
        </div>
      )}
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
