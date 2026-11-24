'use client';

import type { FloorTable, LivePlan, LocationSummary } from '@durby/shared';
import { BellRing, CalendarClock, Clock, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadFloor } from '../../lib/pos/api';
import { loadLivePlans } from '../../lib/pos/floor-plan-api';
import { durationLabel, minutesSince } from '../../lib/pos/format';
import { loadFloor as loadReservationsFloor } from '../../lib/reservations/host';
import {
  reservationsVisible,
  type ServiceBadge,
  serviceBadges,
} from '../../lib/reservations/service';
import { useNow } from '../../lib/pos/use-now';
import { useLiveRefresh } from '../../lib/realtime/use-live-refresh';
import { useMediaQuery } from '../../lib/use-media-query';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { PlanView, TableShapeBox } from '../tables/plan/plan-canvas';
import { NoLocations } from '../settings/locations-page';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { MoneyProvider, useMoney } from './money';
import { PrintWarnings } from './print-warnings';
import { PrinterCommandRunner } from './printer-command-runner';
import { TableIcon } from './table-icon';

/** /service: the floor, every table of a location and its open order (docs/modules/pos.md → Web). */
export function FloorPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('pos.orders.read')) {
    return <NoAccess title="pos.nav.service" />;
  }
  return (
    <MoneyProvider>
      <Floor organizationId={session.activeOrganizationId} />
    </MoneyProvider>
  );
}

function Floor({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const [locations, reload] = useResource(organizationId, () => loadLocations(store));
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) =>
        list.length === 0 ? (
          <div className="flex flex-col gap-6">
            <h1 className="text-2xl font-semibold">{t('pos.nav.service')}</h1>
            <NoLocations message={t('pos.floor.noLocations')} />
          </div>
        ) : (
          <LocationFloor locations={list} />
        )
      }
    </Loaded>
  );
}

type Filter = 'all' | 'open' | 'free';

/** Plans change rarely: how often the page asks again. */
const PLANS_REFRESH_MS = 5 * 60_000;

function LocationFloor({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const { store, session } = useAuth();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  const [filter, setFilter] = useState<Filter>('all');
  const [tables, reloadTables] = useResource(locationId, () => loadFloor(store, locationId));
  // Reservation badges (R1.9): only with the feature and the read key; a failed call hides them.
  const [bookings, reloadBookings] = useResource(
    reservationsVisible(session) ? locationId : null,
    () => loadReservationsFloor(store, locationId, { kind: 'now' }),
  );
  const badges = bookings.status === 'ready' ? serviceBadges(bookings.data) : null;
  const reload = () => {
    reloadTables();
    reloadBookings();
  };
  // Other waiters open and close tables, hosts seat bookings: reload on the pos and reservations
  // streams' hints, polling while a stream isn't live (ADR 0044). The clock ticks on its own.
  useLiveRefresh({
    store,
    stream: 'pos',
    locationId,
    enabled: true,
    reload: reloadTables,
    pollMs: 30_000,
  });
  useLiveRefresh({
    store,
    stream: 'reservations',
    locationId,
    enabled: reservationsVisible(session),
    reload: reloadBookings,
    pollMs: 30_000,
  });
  const now = useNow(30_000);
  // Published floor plans (ADR 0073): not on phones, and only until someone chooses the list (kept in the address).
  const [plans, reloadPlans] = useResource(locationId, () => loadLivePlans(store, locationId));
  useNow(PLANS_REFRESH_MS, reloadPlans);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const roomy = useMediaQuery('(min-width: 768px)');
  const livePlans = plans.status === 'ready' ? plans.data : [];
  const asList = search.get('view') === 'list';
  const setView = (view: 'plan' | 'list') => {
    const next = new URLSearchParams(search.toString());
    if (view === 'list') next.set('view', 'list');
    else next.delete('view');
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: t('pos.floor.filterAll') },
    { value: 'open', label: t('pos.floor.open') },
    { value: 'free', label: t('pos.floor.free') },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Inside the Android app only: runs Find printer and test prints sent from Settings (ADR 0032 §15). */}
      <PrinterCommandRunner
        locationId={locationId}
        locationName={locations.find((l) => l.id === locationId)?.name ?? ''}
      />
      {/* What isn't printing at this location, with Reprint for those who print bills (ADR 0033). */}
      <PrintWarnings
        locationId={locationId}
        canReprint={session?.activePermissions.includes('pos.bills.print') ?? false}
      />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('pos.nav.service')}</h1>
          {tables.status === 'ready' && (
            <p className="text-sm text-muted-foreground" data-testid="floor-summary">
              {t('pos.floor.summary', {
                open: String(tables.data.filter((x) => x.order).length),
                free: String(tables.data.filter((x) => !x.order).length),
              })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {locations.length > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-location`}>{t('pos.floor.location')}</Label>
              <Select
                id={`${id}-location`}
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {roomy && livePlans.length > 0 && (
            <div
              role="group"
              aria-label={t('pos.plan.view.label')}
              className="flex rounded-md border border-border bg-card p-1"
              data-testid="floor-view"
            >
              {(['plan', 'list'] as const).map((view) => {
                const active = asList === (view === 'list');
                return (
                  <Button
                    key={view}
                    variant={active ? 'default' : 'ghost'}
                    className="min-h-9 px-4"
                    aria-pressed={active}
                    onClick={() => setView(view)}
                  >
                    {t(`pos.plan.view.${view}`)}
                  </Button>
                );
              })}
            </div>
          )}
          <div
            role="group"
            aria-label={t('pos.floor.filter')}
            className="flex rounded-md border border-border bg-card p-1"
          >
            {filters.map((f) => (
              <Button
                key={f.value}
                variant={filter === f.value ? 'default' : 'ghost'}
                className="min-h-9 px-4"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <Loaded resource={tables} reload={reload}>
        {(list) => (
          <FloorGrid
            tables={list}
            filter={filter}
            now={now}
            badges={badges}
            plans={roomy && !asList ? livePlans : []}
          />
        )}
      </Loaded>
    </div>
  );
}

function FloorGrid({
  tables,
  filter,
  now,
  badges,
  plans,
}: {
  tables: FloorTable[];
  filter: Filter;
  now: number;
  badges: ReadonlyMap<string, ServiceBadge> | null;
  /** The plans to draw; areas without one are lists. */
  plans: LivePlan[];
}) {
  const t = useT();
  if (tables.length === 0) return <p className="text-muted-foreground">{t('pos.floor.empty')}</p>;
  const matches = (x: FloorTable) =>
    filter === 'all' || (filter === 'open' ? x.order !== null : x.order === null);
  if (!tables.some(matches))
    return <p className="text-muted-foreground">{t('pos.floor.noneMatch')}</p>;

  // Areas in the order their first table appears; tables without one form the main room.
  const areas = new Map<string, FloorTable[]>();
  for (const table of tables) {
    const area = table.area ?? '';
    areas.set(area, [...(areas.get(area) ?? []), table]);
  }
  const sections = [...areas].flatMap(([area, list]) => {
    // Area names are unique at a location.
    const plan = area === '' ? undefined : plans.find((p) => p.areaName === area);
    const drawn = new Set(plan?.layout.tables.map((x) => x.tableId));
    // The plan keeps its tables in place and dims what the filter leaves out; a list hides it.
    const listed = list.filter((x) => !drawn.has(x.id) && matches(x));
    return plan || listed.length > 0 ? [{ area, list, plan, listed }] : [];
  });
  return (
    <div className="flex flex-col gap-6">
      {sections.map(({ area, list, plan, listed }) => (
        <section key={area} className="flex flex-col gap-3" data-testid="floor-area">
          {sections.length > 1 && (
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              {area || t('pos.floor.noArea')}
            </h2>
          )}
          {plan && (
            <AreaPlan plan={plan} tables={list} matches={matches} now={now} badges={badges} />
          )}
          {plan && listed.length > 0 && (
            <h3 className="text-sm text-muted-foreground">{t('pos.plan.others')}</h3>
          )}
          {listed.length > 0 && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {listed.map((table) => (
                <TableTile key={table.id} table={table} now={now} badge={badges?.get(table.id)} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** An area's published plan (ADR 0073): tables in place, with the state a waiter needs at a glance. */
function AreaPlan({
  plan,
  tables,
  matches,
  now,
  badges,
}: {
  plan: LivePlan;
  tables: FloorTable[];
  matches: (table: FloorTable) => boolean;
  now: number;
  badges: ReadonlyMap<string, ServiceBadge> | null;
}) {
  const t = useT();
  const money = useMoney();
  const byId = new Map(tables.map((x) => [x.id, x]));
  return (
    <PlanView
      layout={plan.layout}
      label={plan.areaName}
      testId="floor-plan"
      renderTable={(item) => {
        // Not here any more, or out of service: not drawn.
        const table = item.tableId ? byId.get(item.tableId) : undefined;
        if (!table) return null;
        const { order } = table;
        const badge = badges?.get(table.id);
        const open = order
          ? durationLabel(minutesSince(table.seatedAt ?? order.openedAt, now))
          : null;
        const time = open ? t(open.key, open.values) : null;
        const ready = order?.readyCount ?? 0;
        const facts = [
          t(order ? 'pos.floor.open' : 'pos.floor.free'),
          ...(order && time ? [money(order.gross), t('pos.floor.seated', { time })] : []),
          ...(order ? [] : [t('pos.floor.seats', { count: String(table.seats) })]),
          ...(ready > 0 ? [t('pos.floor.ready', { count: String(ready) })] : []),
          ...(badge?.seatedParty != null ? [t('reservations.service.fromBooking')] : []),
          ...(badge?.next
            ? [
                t('reservations.service.next', {
                  time: badge.next.time,
                  party: t('reservations.host.partyOf', { count: String(badge.next.partySize) }),
                }),
              ]
            : []),
        ];
        const name = `${table.name}: ${facts.join(', ')}`;
        return (
          <Link
            href={`/service/${table.id}`}
            aria-label={name}
            title={name}
            data-testid="floor-plan-table"
            data-name={table.name}
            data-state={order ? 'open' : 'free'}
            className={cn(
              'relative block size-full no-underline hover:no-underline focus-visible:outline-2',
              !matches(table) && 'opacity-35',
            )}
          >
            <TableShapeBox
              shape={table.shape}
              color={table.color}
              className={order ? 'border-4 border-primary! bg-primary/15!' : undefined}
            >
              <span className="text-sm font-semibold">{table.name}</span>
              <span className="text-xs">
                {time ?? t('pos.floor.seats', { count: String(table.seats) })}
              </span>
            </TableShapeBox>
            {ready > 0 && (
              <span className="absolute -top-2 -right-2 inline-flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-0.5 text-xs font-semibold text-accent-foreground shadow-sm">
                <BellRing aria-hidden className="size-3.5" />
                {ready}
              </span>
            )}
            {badge?.next && (
              <span className="absolute -bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-card px-1.5 text-xs whitespace-nowrap">
                <CalendarClock aria-hidden className="size-3" />
                {badge.next.time}
              </span>
            )}
          </Link>
        );
      }}
    />
  );
}

function TableTile({
  table,
  now,
  badge,
}: {
  table: FloorTable;
  now: number;
  badge?: ServiceBadge;
}) {
  const t = useT();
  const money = useMoney();
  const order = table.order;
  /** "42 min" style text for the time since an instant (ADR 0069 timer). */
  const since = (iso: string) => {
    const d = durationLabel(minutesSince(iso, now));
    return t(d.key, d.values);
  };
  const bookingLine = badge && (badge.seatedParty !== null || badge.next) && (
    <span className="flex flex-wrap gap-1.5" data-testid="floor-booking">
      {badge.seatedParty !== null && (
        <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
          {t('reservations.service.fromBooking')}
        </span>
      )}
      {badge.next && (
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          <CalendarClock aria-hidden className="size-3.5" />
          {t('reservations.service.next', {
            time: badge.next.time,
            party: t('reservations.host.partyOf', { count: String(badge.next.partySize) }),
          })}
        </span>
      )}
    </span>
  );
  return (
    <li data-testid="floor-table" data-name={table.name} data-state={order ? 'open' : 'free'}>
      <Link
        href={`/service/${table.id}`}
        className={cn(
          'flex h-full min-h-32 flex-col justify-between gap-3 rounded-lg border p-4 text-foreground no-underline shadow-sm transition-colors hover:no-underline focus-visible:outline-2',
          order
            ? 'border-primary bg-primary/10 hover:bg-primary/15'
            : 'border-border bg-card hover:bg-muted',
        )}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="flex items-center gap-2">
            <TableIcon shape={table.shape} color={table.color} className="size-9" />
            <span className="text-2xl font-semibold leading-none">{table.name}</span>
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium',
              order ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}
          >
            {t(order ? 'pos.floor.open' : 'pos.floor.free')}
          </span>
        </span>
        {order ? (
          <span className="flex flex-col gap-1">
            <span className="text-xl font-semibold tabular-nums">{money(order.gross)}</span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{t('pos.floor.items', { count: String(order.itemCount) })}</span>
              <span className="inline-flex items-center gap-1" data-testid="floor-seated">
                <Clock aria-hidden className="size-3.5" />
                {t('pos.floor.seated', { time: since(table.seatedAt ?? order.openedAt) })}
              </span>
            </span>
            {table.lastOrderAt && (
              <span className="text-xs text-muted-foreground" data-testid="floor-last-order">
                {t('pos.floor.lastOrder', { time: since(table.lastOrderAt) })}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{order.number}</span>
            {order.readyCount > 0 && (
              <span
                className="inline-flex items-center gap-1 self-start rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground"
                data-testid="floor-ready"
              >
                <BellRing aria-hidden className="size-3.5" />
                {t('pos.floor.ready', { count: String(order.readyCount) })}
              </span>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Users aria-hidden className="size-4" />
            {t('pos.floor.seats', { count: String(table.seats) })}
          </span>
        )}
        {bookingLine}
      </Link>
    </li>
  );
}
