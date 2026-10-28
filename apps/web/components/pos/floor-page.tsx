'use client';

import type { FloorTable, LocationSummary } from '@durby/shared';
import { Clock, Users } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadFloor } from '../../lib/pos/api';
import { durationLabel, minutesSince } from '../../lib/pos/format';
import { useNow } from '../../lib/pos/use-now';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { MoneyProvider, useMoney } from './money';
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
            <p className="text-muted-foreground">{t('pos.floor.noLocations')}</p>
          </div>
        ) : (
          <LocationFloor locations={list} />
        )
      }
    </Loaded>
  );
}

type Filter = 'all' | 'open' | 'free';

function LocationFloor({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  const [filter, setFilter] = useState<Filter>('all');
  const [tables, reload] = useResource(locationId, () => loadFloor(store, locationId));
  // Other waiters open and close tables: refresh every 30 s while the page is visible.
  const now = useNow(30_000, reload);

  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: t('pos.floor.filterAll') },
    { value: 'open', label: t('pos.floor.open') },
    { value: 'free', label: t('pos.floor.free') },
  ];

  return (
    <div className="flex flex-col gap-5">
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
        {(list) => <FloorGrid tables={list} filter={filter} now={now} />}
      </Loaded>
    </div>
  );
}

function FloorGrid({ tables, filter, now }: { tables: FloorTable[]; filter: Filter; now: number }) {
  const t = useT();
  if (tables.length === 0) return <p className="text-muted-foreground">{t('pos.floor.empty')}</p>;
  const shown = tables.filter(
    (x) => filter === 'all' || (filter === 'open' ? x.order !== null : x.order === null),
  );
  if (shown.length === 0)
    return <p className="text-muted-foreground">{t('pos.floor.noneMatch')}</p>;

  // Areas in the order their first table appears; tables without one form the main room.
  const areas = new Map<string, FloorTable[]>();
  for (const table of shown) {
    const area = table.area ?? '';
    areas.set(area, [...(areas.get(area) ?? []), table]);
  }
  return (
    <div className="flex flex-col gap-6">
      {[...areas].map(([area, list]) => (
        <section key={area} className="flex flex-col gap-3" data-testid="floor-area">
          {areas.size > 1 && (
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              {area || t('pos.floor.noArea')}
            </h2>
          )}
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {list.map((table) => (
              <TableTile key={table.id} table={table} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TableTile({ table, now }: { table: FloorTable; now: number }) {
  const t = useT();
  const money = useMoney();
  const order = table.order;
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
              <span className="inline-flex items-center gap-1">
                <Clock aria-hidden className="size-3.5" />
                {(() => {
                  const d = durationLabel(minutesSince(order.openedAt, now));
                  return t(d.key, d.values);
                })()}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">{order.number}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Users aria-hidden className="size-4" />
            {t('pos.floor.seats', { count: String(table.seats) })}
          </span>
        )}
      </Link>
    </li>
  );
}
