'use client';

import type {
  LocalDate,
  LocationSummary,
  Reservation,
  ReservationsFloorResponse,
  ReservationsFloorTable,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { ChevronLeft, ChevronRight, Clock, TriangleAlert, Users } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { ApiErrorCode } from '../../lib/auth/errors';
import { errorLabel } from '../../lib/auth/errors';
import { useNow } from '../../lib/pos/use-now';
import {
  actionsFor,
  clockTime,
  dayCounts,
  type FloorMoment,
  type HostAction,
  loadDay,
  loadFloor,
  localDate,
  runAction,
  shiftDate,
  stillOccupied,
  tillBadge,
  timeOptions,
  undoable,
  undoChange,
  undoMinutesLeft,
} from '../../lib/reservations/host';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { NoLocations } from '../settings/locations-page';
import { TableIcon } from '../pos/table-icon';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { BookingDialog, TablesDialog, WalkInDialog } from './host-dialogs';

/** How often the screen refreshes while visible (G6; SSE replaces it in RT.1). */
export const HOST_REFRESH_MS = 30_000;

const READ = 'reservations.bookings.read';
const MANAGE = 'reservations.bookings.manage';

/** /host: the door of one location (docs/modules/reservations.md → Web, R1.8b). */
export function HostPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes(READ)) return <NoAccess title="reservations.nav.host" />;
  return (
    <HostLocations
      organizationId={session.activeOrganizationId}
      canManage={session.activePermissions.includes(MANAGE)}
    />
  );
}

function HostLocations({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [locations, reload] = useResource(organizationId, () => loadLocations(store));
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) =>
        list.length === 0 ? (
          <div className="flex flex-col gap-6">
            <h1 className="text-2xl font-semibold">{t('reservations.nav.host')}</h1>
            <NoLocations message={t('reservations.host.noLocations')} />
          </div>
        ) : (
          <HostScreen locations={list} canManage={canManage} />
        )
      }
    </Loaded>
  );
}

type Dialog =
  | { kind: 'booking' }
  | { kind: 'walkIn'; tableIds: string[] }
  | { kind: 'tables'; booking: Reservation; mode: 'move' | 'seat' }
  | null;

const STATUS_LABEL: Record<Reservation['status'], LabelKey> = {
  requested: 'reservations.status.requested',
  pending: 'reservations.status.pending',
  booked: 'reservations.status.booked',
  arrived: 'reservations.status.arrived',
  seated: 'reservations.status.seated',
  finished: 'reservations.status.finished',
  no_show: 'reservations.status.noShow',
  cancelled: 'reservations.status.cancelled',
  declined: 'reservations.status.declined',
  expired: 'reservations.status.expired',
};

function HostScreen({
  locations,
  canManage,
}: {
  locations: LocationSummary[];
  canManage: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  // null = today (live); another day starts at its first service window (the floor's default).
  const [day, setDay] = useState<LocalDate | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [acted, setActed] = useState<Reservation | null>(null);

  const moment: FloorMoment =
    day === null ? { kind: 'now' } : at ? { kind: 'at', at } : { kind: 'date', date: day };
  const [floor, reloadFloor] = useResource(`${locationId}|${day}|${at}`, () =>
    loadFloor(store, locationId, moment),
  );
  const ready = floor.status === 'ready' ? floor.data : null;
  const date = day ?? ready?.date ?? null;
  const [bookings, reloadBookings] = useResource(date && `${locationId}|${date}`, () =>
    loadDay(store, locationId, date!),
  );
  const reload = useCallback(() => {
    reloadFloor();
    reloadBookings();
  }, [reloadFloor, reloadBookings]);
  // Other hosts and the till change bookings: refresh while visible, like /service.
  const now = useNow(HOST_REFRESH_MS, reload);

  const today = ready ? localDate(now, ready.timeZone) : null;
  const goTo = (next: LocalDate | null) => {
    setDay(next === today ? null : next);
    setAt(null);
  };
  const done = (booking: Reservation) => {
    setActed(booking);
    reload();
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('reservations.nav.host')}</h1>
          {bookings.status === 'ready' && (
            <p className="text-sm text-muted-foreground" data-testid="host-counts">
              {(() => {
                const c = dayCounts(bookings.data);
                return t('reservations.host.counts', {
                  covers: String(c.covers),
                  booked: String(c.booked),
                  seated: String(c.seated),
                });
              })()}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {locations.length > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-location`}>{t('reservations.host.location')}</Label>
              <Select
                id={`${id}-location`}
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  goTo(null);
                }}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {date && (
            <div
              className="flex items-end gap-1"
              role="group"
              aria-label={t('reservations.host.day')}
            >
              <Button
                variant="outline"
                size="icon"
                aria-label={t('reservations.host.previousDay')}
                onClick={() => goTo(shiftDate(date, -1))}
              >
                <ChevronLeft aria-hidden />
              </Button>
              <Button
                variant={day === null ? 'default' : 'outline'}
                aria-pressed={day === null}
                onClick={() => goTo(null)}
              >
                {t('reservations.host.today')}
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label={t('reservations.host.nextDay')}
                onClick={() => goTo(shiftDate(date, 1))}
              >
                <ChevronRight aria-hidden />
              </Button>
              <Input
                type="date"
                className="w-40"
                aria-label={t('reservations.host.date')}
                value={date}
                onChange={(e) => e.target.value && goTo(e.target.value)}
              />
            </div>
          )}
          {ready && !ready.live && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-time`}>{t('reservations.host.time')}</Label>
              <Select
                id={`${id}-time`}
                data-testid="host-time"
                value={ready.at}
                onChange={(e) => setAt(e.target.value)}
              >
                {(() => {
                  const options = timeOptions(ready.serviceWindows, ready.timeZone);
                  const listed = options.some((o) => o.at === ready.at);
                  return [
                    ...(listed
                      ? []
                      : [{ at: ready.at, label: clockTime(ready.at, ready.timeZone) }]),
                    ...options,
                  ].map((o) => (
                    <option key={o.at} value={o.at}>
                      {o.label}
                    </option>
                  ));
                })()}
              </Select>
            </div>
          )}
          {canManage && ready && (
            <>
              <Button data-testid="host-new-booking" onClick={() => setDialog({ kind: 'booking' })}>
                {t('reservations.host.newBooking')}
              </Button>
              {ready.live && (
                <Button
                  variant="outline"
                  data-testid="host-new-walk-in"
                  onClick={() => setDialog({ kind: 'walkIn', tableIds: [] })}
                >
                  {t('reservations.host.newWalkIn')}
                </Button>
              )}
            </>
          )}
        </div>
      </header>

      {ready && !ready.live && (
        <p className="text-sm text-muted-foreground" data-testid="host-plan-note">
          {t('reservations.host.planNote')}
        </p>
      )}

      <Loaded resource={floor} reload={reloadFloor}>
        {(f) => (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <section className="flex flex-col gap-3" aria-labelledby={`${id}-timeline`}>
              <h2 id={`${id}-timeline`} className="text-lg font-semibold">
                {t('reservations.host.timeline')}
              </h2>
              <Loaded resource={bookings} reload={reloadBookings}>
                {(list) => (
                  <Timeline
                    bookings={list}
                    floor={f}
                    now={now}
                    canManage={canManage}
                    onDone={done}
                    onChangeTables={(booking, mode) => setDialog({ kind: 'tables', booking, mode })}
                  />
                )}
              </Loaded>
            </section>
            <section className="flex flex-col gap-3" aria-labelledby={`${id}-floor`}>
              <h2 id={`${id}-floor`} className="text-lg font-semibold">
                {f.live
                  ? t('reservations.host.floorNow')
                  : t('reservations.host.floorAt', { time: clockTime(f.at, f.timeZone) })}
              </h2>
              <Floor
                floor={f}
                bookings={bookings.status === 'ready' ? bookings.data : []}
                now={now}
                canManage={canManage}
                onWalkIn={(tableId) => setDialog({ kind: 'walkIn', tableIds: [tableId] })}
                onDone={done}
              />
            </section>
          </div>
        )}
      </Loaded>

      {acted && undoable(acted, now) && (
        <UndoBar booking={acted} now={now} onDone={done} onDismiss={() => setActed(null)} />
      )}

      {ready && dialog?.kind === 'booking' && (
        <BookingDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          locationId={locationId}
          timeZone={ready.timeZone}
          date={ready.date}
          time={ready.live ? nextQuarter(now, ready.timeZone) : clockTime(ready.at, ready.timeZone)}
          tables={ready.data}
          onDone={() => reload()}
        />
      )}
      {ready && dialog?.kind === 'walkIn' && (
        <WalkInDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          locationId={locationId}
          timeZone={ready.timeZone}
          tables={ready.data}
          initialTableIds={dialog.tableIds}
          now={now}
          onDone={done}
        />
      )}
      {ready && dialog?.kind === 'tables' && (
        <TablesDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          booking={dialog.booking}
          mode={dialog.mode}
          tables={ready.data}
          onDone={done}
        />
      )}
    </div>
  );
}

/** The next quarter hour at the location (default time of a booking made for today). */
function nextQuarter(now: number, timeZone: string): string {
  const quarter = 15 * 60_000;
  return clockTime(new Date(Math.ceil(now / quarter) * quarter).toISOString(), timeZone);
}

// --- Timeline -------------------------------------------------------------------------------------

function Timeline({
  bookings,
  floor,
  now,
  canManage,
  onDone,
  onChangeTables,
}: {
  bookings: Reservation[];
  floor: ReservationsFloorResponse;
  now: number;
  canManage: boolean;
  onDone: (booking: Reservation) => void;
  onChangeTables: (booking: Reservation, mode: 'move' | 'seat') => void;
}) {
  const t = useT();
  if (bookings.length === 0) {
    return <p className="text-muted-foreground">{t('reservations.host.noBookings')}</p>;
  }
  const names = new Map(floor.data.map((x) => [x.id, x.name]));
  const occupied = floor.live ? stillOccupied(floor.data) : new Set<string>();
  return (
    <ul className="flex flex-col gap-2">
      {bookings.map((booking) => (
        <TimelineRow
          key={booking.id}
          booking={booking}
          tableNames={booking.tableIds.map((x) => names.get(x) ?? t('reservations.host.tableGone'))}
          timeZone={floor.timeZone}
          live={floor.live}
          stillOccupied={occupied.has(booking.id)}
          now={now}
          canManage={canManage}
          onDone={onDone}
          onChangeTables={onChangeTables}
        />
      ))}
    </ul>
  );
}

const ACTION_LABEL: Record<HostAction, LabelKey> = {
  arrive: 'reservations.host.actions.arrive',
  seat: 'reservations.host.actions.seat',
  finish: 'reservations.host.actions.finish',
  'no-show': 'reservations.host.actions.noShow',
  cancel: 'reservations.host.actions.cancel',
};

function TimelineRow({
  booking,
  tableNames,
  timeZone,
  live,
  stillOccupied: tableStillOccupied,
  now,
  canManage,
  onDone,
  onChangeTables,
}: {
  booking: Reservation;
  tableNames: string[];
  timeZone: string;
  live: boolean;
  stillOccupied: boolean;
  now: number;
  canManage: boolean;
  onDone: (booking: Reservation) => void;
  onChangeTables: (booking: Reservation, mode: 'move' | 'seat') => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [failure, setFailure] = useState<ApiErrorCode | 'unknown' | null>(null);
  const [busy, setBusy] = useState(false);
  const guest = booking.guest.name ?? t('reservations.host.noName');
  const badge = tillBadge(booking);
  const notInService = booking.tablesNotInService.length > 0;
  const terminal = actionsFor(booking, now).length === 0;

  // Cancel and no-show confirm first; ConfirmAction's onDone gets no answer, so pass it on here.
  const confirmed = (what: 'cancel' | 'no-show') => async () => {
    const result = await runAction(store, action, booking.id, what);
    if (result.ok && result.data) onDone(result.data);
    return result;
  };

  async function run(what: HostAction) {
    setBusy(true);
    setFailure(null);
    const result = await runAction(store, action, booking.id, what);
    setBusy(false);
    if (result.ok && result.data) return onDone(result.data);
    const code = result.ok ? 'unknown' : result.code;
    // The booking's own table was archived since: seat it elsewhere.
    if (what === 'seat' && code === 'reservations.table_not_in_service') {
      return onChangeTables(booking, 'seat');
    }
    setFailure(code);
  }

  const undo = async () => {
    setBusy(true);
    setFailure(null);
    const result = await undoChange(store, action, booking.id, booking.lastChange.id);
    setBusy(false);
    if (result.ok && result.data) onDone(result.data);
    else setFailure(result.ok ? 'unknown' : result.code);
  };

  return (
    <li
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border bg-card p-3',
        terminal && 'opacity-70',
      )}
      data-testid="timeline-row"
      data-guest={booking.guest.name ?? ''}
      data-status={booking.status}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-lg font-semibold tabular-nums">
            {clockTime(booking.startsAt, timeZone)}
          </span>
          <span className="font-medium">{guest}</span>
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Users aria-hidden className="size-3.5" />
            {t('reservations.host.partyOf', { count: String(booking.partySize) })}
          </span>
          <span className="text-sm text-muted-foreground">{tableNames.join(' + ')}</span>
        </span>
        <Badge data-testid="row-status">{t(STATUS_LABEL[booking.status])}</Badge>
      </div>
      {(badge || notInService || tableStillOccupied) && (
        <div className="flex flex-wrap items-center gap-2">
          {badge && (
            <Badge className="border-primary text-primary-text" data-testid="till-badge">
              {t(
                badge === 'autoSeated'
                  ? 'reservations.host.autoSeated'
                  : 'reservations.host.finishedAtTill',
              )}
            </Badge>
          )}
          {(notInService || tableStillOccupied) && (
            <span
              className="inline-flex items-center gap-1 text-sm font-medium text-destructive"
              data-testid="row-flag"
            >
              <TriangleAlert aria-hidden className="size-4" />
              {t(
                notInService ? 'reservations.host.notInService' : 'reservations.host.stillOccupied',
              )}
            </span>
          )}
        </div>
      )}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          {live &&
            actionsFor(booking, now)
              .filter((a) => a !== 'cancel' && a !== 'no-show')
              .map((a) => (
                <Button
                  key={a}
                  variant={a === 'seat' ? 'default' : 'outline'}
                  disabled={busy}
                  data-testid={`row-${a}`}
                  onClick={() => void run(a)}
                >
                  {t(ACTION_LABEL[a])}
                </Button>
              ))}
          {live && actionsFor(booking, now).includes('no-show') && (
            <ConfirmAction
              trigger={t('reservations.host.actions.noShow')}
              title={t('reservations.host.confirmNoShow.title', { guest })}
              description={t('reservations.host.confirmNoShow.description')}
              confirm={t('reservations.host.actions.noShow')}
              testId="row-no-show"
              run={confirmed('no-show')}
              onDone={() => undefined}
            />
          )}
          {actionsFor(booking, now).includes('cancel') && (
            <ConfirmAction
              trigger={t('reservations.host.actions.cancel')}
              title={t('reservations.host.confirmCancel.title', { guest })}
              description={t('reservations.host.confirmCancel.description')}
              confirm={t('reservations.host.actions.cancel')}
              testId="row-cancel"
              run={confirmed('cancel')}
              onDone={() => undefined}
            />
          )}
          {(notInService || tableStillOccupied) && !terminal && (
            <Button
              variant="outline"
              disabled={busy}
              data-testid="row-change-tables"
              onClick={() => onChangeTables(booking, 'move')}
            >
              {t('reservations.host.changeTables')}
            </Button>
          )}
          {badge && undoable(booking, now) && (
            <Button
              variant="ghost"
              disabled={busy}
              data-testid="row-undo"
              onClick={() => void undo()}
            >
              {t('reservations.host.undo', { minutes: String(undoMinutesLeft(booking, now)) })}
            </Button>
          )}
        </div>
      )}
      <Notice text={failure ? t(errorLabel(failure)) : null} tone="error" />
    </li>
  );
}

// --- Floor ----------------------------------------------------------------------------------------

const STATE_LABEL: Record<ReservationsFloorTable['state'], LabelKey> = {
  occupied: 'reservations.host.state.occupied',
  arriving: 'reservations.host.state.arriving',
  reserved: 'reservations.host.state.reserved',
  reserved_soon: 'reservations.host.state.reservedSoon',
  free: 'reservations.host.state.free',
};

function Floor({
  floor,
  bookings,
  now,
  canManage,
  onWalkIn,
  onDone,
}: {
  floor: ReservationsFloorResponse;
  bookings: Reservation[];
  now: number;
  canManage: boolean;
  onWalkIn: (tableId: string) => void;
  onDone: (booking: Reservation) => void;
}) {
  const t = useT();
  if (floor.data.length === 0) {
    return <p className="text-muted-foreground">{t('reservations.host.noTables')}</p>;
  }
  const areas = new Map<string, ReservationsFloorTable[]>();
  for (const table of floor.data) {
    const area = table.area ?? '';
    areas.set(area, [...(areas.get(area) ?? []), table]);
  }
  const byId = new Map(bookings.map((b) => [b.id, b]));
  return (
    <div className="flex flex-col gap-5">
      {[...areas].map(([area, tables]) => (
        <div key={area} className="flex flex-col gap-2" data-testid="host-area">
          {areas.size > 1 && (
            <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              {area || t('reservations.host.noArea')}
            </h3>
          )}
          <ul className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {tables.map((table) => (
              <FloorTile
                key={table.id}
                table={table}
                timeZone={floor.timeZone}
                live={floor.live}
                next={table.next ? byId.get(table.next.reservationId) : undefined}
                now={now}
                canManage={canManage}
                onWalkIn={onWalkIn}
                onDone={onDone}
              />
            ))}
          </ul>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t('reservations.host.legend')}</p>
    </div>
  );
}

function FloorTile({
  table,
  timeZone,
  live,
  next,
  now,
  canManage,
  onWalkIn,
  onDone,
}: {
  table: ReservationsFloorTable;
  timeZone: string;
  live: boolean;
  /** The table's next booking, when it is in the day's list. */
  next: Reservation | undefined;
  now: number;
  canManage: boolean;
  onWalkIn: (tableId: string) => void;
  onDone: (booking: Reservation) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [failure, setFailure] = useState<ApiErrorCode | 'unknown' | null>(null);
  const seatable = live && canManage && (table.state === 'free' || table.state === 'reserved_soon');
  const seatNext =
    next &&
    (next.status === 'booked' || next.status === 'arrived') &&
    actionsFor(next, now).includes('seat');

  const body = (
    <>
      <span className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <TableIcon shape={table.shape} color={table.color} className="size-7 shrink-0" />
          <span className="text-xl font-semibold leading-none break-words">{table.name}</span>
        </span>
        <span
          className={cn(
            'shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
            table.state === 'occupied' && 'bg-primary text-primary-foreground',
            table.state === 'arriving' && 'bg-accent text-accent-foreground',
            table.state !== 'occupied' &&
              table.state !== 'arriving' &&
              'bg-muted text-muted-foreground',
          )}
        >
          {t(STATE_LABEL[table.state])}
        </span>
      </span>
      <span className="flex flex-col gap-1 text-sm">
        {table.current && (
          <span
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
            data-testid="tile-current"
          >
            <span className="font-medium">
              {table.current.guestName ??
                (table.current.reservationId
                  ? t('reservations.host.noName')
                  : t('reservations.host.tillOrder'))}
            </span>
            {table.current.partySize !== null && (
              <span className="text-muted-foreground">
                {t('reservations.host.partyOf', { count: String(table.current.partySize) })}
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock aria-hidden className="size-3.5" />
              {t('reservations.host.since', { time: clockTime(table.current.since, timeZone) })}
            </span>
          </span>
        )}
        {table.next && (
          <span className="text-muted-foreground" data-testid="tile-next">
            {t('reservations.host.nextBooking', {
              time: clockTime(table.next.startsAt, timeZone),
              guest: table.next.guestName ?? t('reservations.host.noName'),
              count: String(table.next.partySize),
            })}
          </span>
        )}
        {!table.current && !table.next && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Users aria-hidden className="size-3.5" />
            {t('reservations.host.seats', { count: String(table.seats) })}
          </span>
        )}
      </span>
      {(table.overrun || table.walkInOnly || table.next?.tableStillOccupied) && (
        <span className="flex flex-wrap gap-1">
          {table.overrun && (
            <Badge className="border-destructive text-destructive" data-testid="tile-overrun">
              {t('reservations.host.overrun')}
            </Badge>
          )}
          {table.next?.tableStillOccupied && (
            <Badge className="border-destructive text-destructive">
              {t('reservations.host.stillOccupied')}
            </Badge>
          )}
          {table.walkInOnly && <Badge>{t('reservations.host.walkInOnly')}</Badge>}
        </span>
      )}
    </>
  );
  const tile = cn(
    'flex h-full min-h-28 w-full flex-col justify-between gap-2 rounded-lg border p-3 text-left text-foreground',
    table.state === 'occupied' && 'border-primary bg-primary/10',
    table.state === 'arriving' && 'border-accent bg-accent/30',
    table.state === 'reserved' && 'border-dashed border-primary bg-card',
    table.state === 'reserved_soon' && 'border-border bg-muted',
    table.state === 'free' && 'border-border bg-card',
  );

  return (
    <li data-testid="host-table" data-name={table.name} data-state={table.state}>
      {seatable ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(tile, 'transition-colors hover:bg-muted focus-visible:outline-2')}
              aria-label={t('reservations.host.tableActions', { name: table.name })}
            >
              {body}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => onWalkIn(table.id)} data-testid="tile-walk-in">
              {t('reservations.host.seatWalkIn')}
            </DropdownMenuItem>
            {seatNext && (
              <DropdownMenuItem
                data-testid="tile-seat-next"
                onSelect={() =>
                  void runAction(store, action, next.id, 'seat').then((result) => {
                    if (result.ok && result.data) onDone(result.data);
                    else setFailure(result.ok ? 'unknown' : result.code);
                  })
                }
              >
                {t('reservations.host.seatNext', {
                  guest: next.guest.name ?? t('reservations.host.noName'),
                })}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className={tile}>{body}</div>
      )}
      <Notice text={failure ? t(errorLabel(failure)) : null} tone="error" />
    </li>
  );
}

// --- Undo bar -------------------------------------------------------------------------------------

function UndoBar({
  booking,
  now,
  onDone,
  onDismiss,
}: {
  booking: Reservation;
  now: number;
  onDone: (booking: Reservation) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [failure, setFailure] = useState<ApiErrorCode | 'unknown' | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="status"
      className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      data-testid="undo-bar"
    >
      <span>
        {t('reservations.host.undoBarText', {
          guest: booking.guest.name ?? t('reservations.host.noName'),
          status: t(STATUS_LABEL[booking.status]),
        })}
      </span>
      <span className="flex items-center gap-2">
        <Notice text={failure ? t(errorLabel(failure)) : null} tone="error" />
        <Button
          variant="outline"
          disabled={busy}
          data-testid="undo-bar-undo"
          onClick={() => {
            setBusy(true);
            void undoChange(store, action, booking.id, booking.lastChange.id).then((result) => {
              setBusy(false);
              // The undo itself can't be undone: the bar closes (undoable() is false for it).
              if (result.ok && result.data) onDone(result.data);
              else {
                setFailure(result.ok ? 'unknown' : result.code);
              }
            });
          }}
        >
          {t('reservations.host.undo', { minutes: String(undoMinutesLeft(booking, now)) })}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          {t('platform.common.close')}
        </Button>
      </span>
    </div>
  );
}
