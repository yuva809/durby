'use client';

import type { FloorTable, LocationSummary } from '@durby/shared';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadFloor } from '../../lib/pos/api';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';

/** /pos: the floor, every table of a location and its open order (docs/modules/pos.md → Step 3). */
export function FloorPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('pos.orders.read')) {
    return <NoAccess title="pos.nav.title" />;
  }
  return <Floor organizationId={session.activeOrganizationId} />;
}

function Floor({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const [locations, reload] = useResource(organizationId, () => loadLocations(store));
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('pos.nav.title')}</h1>
      <Loaded resource={locations} reload={reload}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">{t('pos.floor.noLocations')}</p>
          ) : (
            <LocationFloor locations={list} />
          )
        }
      </Loaded>
    </div>
  );
}

function LocationFloor({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  const [tables, reload] = useResource(locationId, () => loadFloor(store, locationId));
  return (
    <div className="flex flex-col gap-4">
      {locations.length > 1 && (
        <div className="grid max-w-xs gap-1.5">
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
      <Loaded resource={tables} reload={reload}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">{t('pos.floor.empty')}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {list.map((table) => (
                <TableTile key={table.id} table={table} />
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}

function TableTile({ table }: { table: FloorTable }) {
  const t = useT();
  const open = table.order !== null;
  return (
    <li data-testid="floor-table" data-name={table.name} data-state={open ? 'open' : 'free'}>
      <Link
        href={`/pos/order/${table.id}`}
        className={cn(
          'flex min-h-28 flex-col gap-1 rounded-lg border p-4 text-foreground no-underline hover:no-underline',
          open ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-muted',
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="text-xl font-semibold">{table.name}</span>
          <Badge>{t(open ? 'pos.floor.open' : 'pos.floor.free')}</Badge>
        </span>
        {table.order && (
          <>
            <span className="text-sm text-muted-foreground">{table.order.number}</span>
            <span className="text-sm">
              {t('pos.floor.items', { count: String(table.order.itemCount) })} ·{' '}
              <span className="tabular-nums">{table.order.gross}</span>
            </span>
          </>
        )}
      </Link>
    </li>
  );
}
