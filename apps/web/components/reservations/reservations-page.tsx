'use client';

import {
  addDays,
  type LocalDate,
  type LocationSummary,
  MAX_LIST_DAYS,
  type Reservation,
  type ReservationsFloorResponse,
  zonedDayBounds,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { Search, Users } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { localeOf } from '../../lib/labels/labels';
import { useNow } from '../../lib/pos/use-now';
import { useLiveRefresh } from '../../lib/realtime/use-live-refresh';
import {
  actionsFor,
  clockTime,
  loadFloor,
  loadRange,
  localDate,
  nextQuarter,
  runAction,
} from '../../lib/reservations/host';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { NoLocations } from '../settings/locations-page';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { BookingDialog } from './host-dialogs';

const READ = 'reservations.bookings.read';
const MANAGE = 'reservations.bookings.edit';
const ERASE = 'reservations.setup.delete';
/** Statuses PATCH accepts (R1.6b). */
const EDITABLE = new Set<Reservation['status']>(['pending', 'booked', 'arrived', 'seated']);
/** The list refreshes like /host while visible. */
const REFRESH_MS = 30_000;

export const STATUS_LABEL: Record<Reservation['status'], LabelKey> = {
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

/** /reservations: the bookings of a location over a few days (docs/modules/reservations.md → Web, R1.9). */
export function ReservationsPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes(READ)) {
    return <NoAccess title="reservations.nav.reservations" />;
  }
  return (
    <Locations
      organizationId={session.activeOrganizationId}
      canManage={session.activePermissions.includes(MANAGE)}
      canErase={session.activePermissions.includes(ERASE)}
      locale={localeOf(session)}
    />
  );
}

function Locations({
  organizationId,
  ...rest
}: {
  organizationId: string | null;
  canManage: boolean;
  canErase: boolean;
  locale: string;
}) {
  const t = useT();
  const { store } = useAuth();
  const [locations, reload] = useResource(organizationId, () => loadLocations(store));
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) =>
        list.length === 0 ? (
          <div className="flex flex-col gap-6">
            <h1 className="text-2xl font-semibold">{t('reservations.nav.reservations')}</h1>
            <NoLocations message={t('reservations.host.noLocations')} />
          </div>
        ) : (
          <BookingList locations={list} {...rest} />
        )
      }
    </Loaded>
  );
}

/** Lower-case text a search can match: guest name, phone, email and the booking number. */
function searchable(booking: Reservation): string {
  const g = booking.guest;
  return [g.name, g.phone, g.email, booking.number].filter(Boolean).join(' ').toLowerCase();
}

/** Days from `from` through `to`, or null when the range is backwards or too long. */
function rangeDays(from: LocalDate, to: LocalDate): number | null {
  if (to < from) return null;
  let days = 1;
  for (let d = from; d !== to; d = addDays(d, 1)) {
    if (++days > MAX_LIST_DAYS) return null;
  }
  return days;
}

type Dialog = { kind: 'new' } | { kind: 'edit'; booking: Reservation } | null;

function BookingList({
  locations,
  canManage,
  canErase,
  locale,
}: {
  locations: LocationSummary[];
  canManage: boolean;
  canErase: boolean;
  locale: string;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  // Until chosen, the range is the location's today (from the floor, in its time zone).
  const [from, setFrom] = useState<LocalDate | null>(null);
  const [to, setTo] = useState<LocalDate | null>(null);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);

  const [floor, reloadFloor] = useResource(locationId, () =>
    loadFloor(store, locationId, { kind: 'now' }),
  );
  const ready = floor.status === 'ready' ? floor.data : null;
  const start = from ?? ready?.date ?? null;
  const end = to ?? start;
  const days = start && end ? rangeDays(start, end) : null;
  const [bookings, reloadBookings] = useResource(
    ready && start && end && days !== null ? `${locationId}|${start}|${end}` : null,
    () =>
      loadRange(
        store,
        locationId,
        zonedDayBounds(start!, ready!.timeZone).start.toISOString(),
        zonedDayBounds(end!, ready!.timeZone).end.toISOString(),
      ),
  );
  const reload = () => {
    reloadFloor();
    reloadBookings();
  };
  // Other devices change bookings: reload on the reservations stream's hints, polling while it
  // isn't live (ADR 0044).
  useLiveRefresh({
    store,
    stream: 'reservations',
    locationId,
    enabled: true,
    reload,
    pollMs: REFRESH_MS,
  });
  const now = useNow(REFRESH_MS);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t('reservations.nav.reservations')}</h1>
        <div className="flex flex-wrap items-end gap-3">
          {locations.length > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-location`}>{t('reservations.host.location')}</Label>
              <Select
                id={`${id}-location`}
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  setFrom(null);
                  setTo(null);
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
          {start && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-from`}>{t('reservations.list.from')}</Label>
                <Input
                  id={`${id}-from`}
                  type="date"
                  className="w-40"
                  value={start}
                  data-testid="list-from"
                  onChange={(e) => {
                    if (!e.target.value) return;
                    setFrom(e.target.value);
                    if (end && e.target.value > end) setTo(e.target.value);
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-to`}>{t('reservations.list.to')}</Label>
                <Input
                  id={`${id}-to`}
                  type="date"
                  className="w-40"
                  value={end ?? start}
                  data-testid="list-to"
                  onChange={(e) => e.target.value && setTo(e.target.value)}
                />
              </div>
            </>
          )}
          {canManage && ready && (
            <Button data-testid="list-new-booking" onClick={() => setDialog({ kind: 'new' })}>
              {t('reservations.host.newBooking')}
            </Button>
          )}
        </div>
      </header>

      <div className="relative max-w-md">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          className="pl-9"
          aria-label={t('reservations.list.search')}
          placeholder={t('reservations.list.search')}
          value={search}
          data-testid="list-search"
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {start && end && days === null ? (
        <p role="alert" className="text-sm text-destructive" data-testid="list-range-invalid">
          {t('reservations.list.rangeInvalid', { days: String(MAX_LIST_DAYS) })}
        </p>
      ) : (
        <Loaded resource={floor} reload={reloadFloor}>
          {(f) => (
            <Loaded resource={bookings} reload={reloadBookings}>
              {(list) => (
                <Rows
                  bookings={list}
                  floor={f}
                  search={search}
                  now={now}
                  locale={locale}
                  canManage={canManage}
                  onEdit={(booking) => setDialog({ kind: 'edit', booking })}
                  onDone={reload}
                />
              )}
            </Loaded>
          )}
        </Loaded>
      )}

      {ready && dialog && (
        <BookingDialog
          key={dialog.kind === 'edit' ? dialog.booking.id : 'new'}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          locationId={locationId}
          timeZone={ready.timeZone}
          date={start ?? ready.date}
          time={nextQuarter(now, ready.timeZone)}
          tables={ready.data}
          booking={dialog.kind === 'edit' ? dialog.booking : undefined}
          canErase={canErase}
          onDone={reload}
        />
      )}
    </div>
  );
}

function Rows({
  bookings,
  floor,
  search,
  now,
  locale,
  canManage,
  onEdit,
  onDone,
}: {
  bookings: Reservation[];
  floor: ReservationsFloorResponse;
  search: string;
  now: number;
  locale: string;
  canManage: boolean;
  onEdit: (booking: Reservation) => void;
  onDone: () => void;
}) {
  const t = useT();
  const needle = search.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? bookings.filter((b) => searchable(b).includes(needle)) : bookings),
    [bookings, needle],
  );
  if (bookings.length === 0) {
    return <p className="text-muted-foreground">{t('reservations.list.empty')}</p>;
  }
  if (shown.length === 0) {
    return <p className="text-muted-foreground">{t('reservations.list.noneMatch')}</p>;
  }
  const names = new Map(floor.data.map((x) => [x.id, x.name]));
  const day = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: floor.timeZone,
  });
  return (
    <ul className="flex flex-col gap-2" data-testid="list-rows">
      {shown.map((booking) => (
        <Row
          key={booking.id}
          booking={booking}
          day={day.format(new Date(booking.startsAt))}
          today={localDate(Date.parse(booking.startsAt), floor.timeZone) === floor.date}
          time={clockTime(booking.startsAt, floor.timeZone)}
          tableNames={booking.tableIds.map((x) => names.get(x) ?? t('reservations.host.tableGone'))}
          now={now}
          canManage={canManage}
          onEdit={() => onEdit(booking)}
          onDone={onDone}
        />
      ))}
    </ul>
  );
}

function Row({
  booking,
  day,
  today,
  time,
  tableNames,
  now,
  canManage,
  onEdit,
  onDone,
}: {
  booking: Reservation;
  day: string;
  today: boolean;
  time: string;
  tableNames: string[];
  now: number;
  canManage: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const erased = booking.guest.anonymisedAt !== null;
  const guest = erased
    ? t('reservations.guest.erased')
    : (booking.guest.name ?? t('reservations.host.noName'));
  const cancellable = actionsFor(booking, now).includes('cancel');
  return (
    <li
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3',
        !EDITABLE.has(booking.status) && 'opacity-70',
      )}
      data-testid="list-row"
      data-number={booking.number}
      data-status={booking.status}
    >
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn('text-sm text-muted-foreground', today && 'font-medium text-foreground')}
        >
          {day}
        </span>
        <span className="text-lg font-semibold tabular-nums">{time}</span>
        <span className={cn('font-medium', erased && 'italic text-muted-foreground')}>{guest}</span>
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <Users aria-hidden className="size-3.5" />
          {t('reservations.host.partyOf', { count: String(booking.partySize) })}
        </span>
        <span className="text-sm text-muted-foreground">{tableNames.join(' + ')}</span>
        <span className="text-xs text-muted-foreground">{booking.number}</span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5">
          {booking.source === 'online' && (
            <Badge className="border-primary text-primary-text" data-testid="row-online">
              {t('reservations.host.online')}
            </Badge>
          )}
          <Badge data-testid="row-status">{t(STATUS_LABEL[booking.status])}</Badge>
        </span>
        {canManage && EDITABLE.has(booking.status) && (
          <Button variant="outline" data-testid="list-edit" onClick={onEdit}>
            {t('reservations.list.edit')}
          </Button>
        )}
        {canManage && cancellable && (
          <ConfirmAction
            trigger={t('reservations.host.actions.cancel')}
            title={t('reservations.host.confirmCancel.title', { guest })}
            description={t('reservations.host.confirmCancel.description')}
            confirm={t('reservations.host.actions.cancel')}
            testId="list-cancel"
            run={() => runAction(store, action, booking.id, 'cancel')}
            onDone={onDone}
          />
        )}
      </span>
    </li>
  );
}
