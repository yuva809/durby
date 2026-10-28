'use client';

import {
  type DiningTable,
  type FloorTable,
  type LocationSummary,
  TABLE_AREA_MAX_LENGTH,
  TABLE_COLORS,
  TABLE_MAX_SEATS,
  TABLE_NAME_MAX_LENGTH,
  TABLE_SHAPES,
  type TableColor,
  type TableShape,
} from '@durby/shared';
import { Eye, EyeOff, Pencil, Search } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createTable, loadFloor, loadTables, updateTable } from '../../lib/pos/api';
import { durationLabel, minutesSince } from '../../lib/pos/format';
import { useNow } from '../../lib/pos/use-now';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { TableIcon, tableColors } from './table-icon';

interface Access {
  canManage: boolean;
  /** pos.orders.read: show which tables are occupied. */
  canSeeOrders: boolean;
}

/**
 * /pos/tables: the floor plan admin (docs/modules/pos.md → Web). Tables per area with their look
 * and status; "out of service" tables are the archived ones.
 */
export function TablesPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('pos.tables.read')) return <NoAccess title="pos.nav.tables" />;
  return (
    <Tables
      organizationId={session.activeOrganizationId}
      access={{
        canManage: permissions.has('pos.tables.manage'),
        canSeeOrders: permissions.has('pos.orders.read'),
      }}
    />
  );
}

function Tables({ organizationId, access }: { organizationId: string | null; access: Access }) {
  const t = useT();
  const { store } = useAuth();
  const [locations, reload] = useResource(organizationId, () => loadLocations(store));
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) =>
        list.length === 0 ? (
          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold">{t('pos.nav.tables')}</h1>
            <p className="text-muted-foreground">{t('pos.tablesPage.noLocations')}</p>
          </div>
        ) : (
          <LocationTables locations={list} access={access} />
        )
      }
    </Loaded>
  );
}

function LocationTables({ locations, access }: { locations: LocationSummary[]; access: Access }) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  const [query, setQuery] = useState('');
  const [showOut, setShowOut] = useState(false);
  const [tables, reloadTables] = useResource(locationId, () => loadTables(store, locationId, true));
  const [floor, reloadFloor] = useResource(access.canSeeOrders ? locationId : null, () =>
    loadFloor(store, locationId),
  );
  const reload = () => {
    reloadTables();
    if (access.canSeeOrders) reloadFloor();
  };
  const now = useNow(30_000);

  const orders = new Map(
    floor.status === 'ready' ? floor.data.map((x) => [x.id, x.order] as const) : [],
  );
  const all = tables.status === 'ready' ? tables.data : [];
  const inService = all.filter((x) => x.archivedAt === null);
  const outOfService = all.length - inService.length;
  const occupied = inService.filter((x) => orders.get(x.id)).length;
  const areas = [...new Set(all.map((x) => x.area).filter((a): a is string => a !== null))];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('pos.nav.tables')}</h1>
          <p className="text-muted-foreground">{t('pos.tablesPage.description')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {locations.length > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-location`}>{t('pos.tablesPage.location')}</Label>
              <Select
                id={`${id}-location`}
                data-testid="location-select"
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
          {access.canManage && (
            <TableDialog locationId={locationId} areas={areas} onDone={reload} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="table-kpis">
        <Kpi label={t('pos.tablesPage.kpiInService')} value={inService.length} />
        {access.canSeeOrders && (
          <>
            <Kpi label={t('pos.tablesPage.kpiAvailable')} value={inService.length - occupied} />
            <Kpi
              label={t('pos.tablesPage.kpiOccupied')}
              value={occupied}
              highlight={occupied > 0}
            />
          </>
        )}
        <Kpi label={t('pos.tablesPage.kpiOutOfService')} value={outOfService} />
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-60 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <label htmlFor={`${id}-search`} className="sr-only">
            {t('pos.tablesPage.search')}
          </label>
          <Input
            id={`${id}-search`}
            type="search"
            className="pl-9"
            placeholder={t('pos.tablesPage.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          className="gap-2"
          aria-pressed={showOut}
          data-testid="toggle-out-of-service"
          onClick={() => setShowOut((v) => !v)}
        >
          {showOut ? (
            <Eye aria-hidden className="size-4" />
          ) : (
            <EyeOff aria-hidden className="size-4" />
          )}
          {t(showOut ? 'pos.tablesPage.hideOutOfService' : 'pos.tablesPage.showOutOfService', {
            count: String(outOfService),
          })}
        </Button>
      </div>

      <Loaded resource={tables} reload={reloadTables}>
        {(list) => (
          <AreaSections
            tables={list.filter(
              (x) =>
                (showOut || x.archivedAt === null) && matches(x, query.trim().toLocaleLowerCase()),
            )}
            orders={orders}
            now={now}
            access={access}
            areas={areas}
            onDone={reload}
          />
        )}
      </Loaded>
    </div>
  );
}

function matches(table: DiningTable, needle: string): boolean {
  if (needle === '') return true;
  return [table.name, table.area ?? ''].some((s) => s.toLocaleLowerCase().includes(needle));
}

function Kpi({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <Card className={cn('flex flex-col gap-1 p-4', highlight && 'border-primary')}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-3xl font-semibold tabular-nums">{value}</span>
    </Card>
  );
}

function AreaSections({
  tables,
  orders,
  now,
  access,
  areas,
  onDone,
}: {
  tables: DiningTable[];
  orders: ReadonlyMap<string, FloorTable['order'] | undefined>;
  now: number;
  access: Access;
  areas: string[];
  onDone: () => void;
}) {
  const t = useT();
  if (tables.length === 0)
    return <p className="text-muted-foreground">{t('pos.tablesPage.empty')}</p>;
  const groups = new Map<string, DiningTable[]>();
  for (const table of tables) {
    const area = table.area ?? '';
    groups.set(area, [...(groups.get(area) ?? []), table]);
  }
  return (
    <div className="flex flex-col gap-8">
      {[...groups].map(([area, list]) => (
        <section key={area} className="flex flex-col gap-3" data-testid="table-area">
          <h2 className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">{area || t('pos.floor.noArea')}</span>
            <span className="text-sm text-muted-foreground">
              {list.length === 1
                ? t('pos.tablesPage.tableCountOne')
                : t('pos.tablesPage.tableCount', { count: String(list.length) })}
            </span>
          </h2>
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((table) => (
              <TableCard
                key={table.id}
                table={table}
                order={orders.get(table.id) ?? null}
                now={now}
                access={access}
                areas={areas}
                onDone={onDone}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TableCard({
  table,
  order,
  now,
  access,
  areas,
  onDone,
}: {
  table: DiningTable;
  order: FloorTable['order'];
  now: number;
  access: Access;
  areas: string[];
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const out = table.archivedAt !== null;
  const status = out ? 'outOfService' : order ? 'occupied' : 'available';
  const duration = order ? durationLabel(minutesSince(order.openedAt, now)) : null;

  async function toggleService() {
    const result = await updateTable(store, action, table.id, { archived: !out });
    if (result.ok) onDone();
  }

  return (
    <li data-testid="table-card" data-name={table.name} data-status={status}>
      <Card
        className={cn('flex h-full flex-col gap-4 border-l-4 p-4', out && 'opacity-60')}
        style={{ borderLeftColor: order ? tableColors(table.color).stroke : undefined }}
      >
        <div className="flex items-start gap-3">
          <TableIcon shape={table.shape} color={table.color} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-lg font-semibold">{table.name}</span>
            <span className="text-sm text-muted-foreground">
              {t('pos.floor.seats', { count: String(table.seats) })}
            </span>
          </div>
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-xs font-medium',
              status === 'occupied'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {t(`pos.tablesPage.status.${status}`)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {order && duration
            ? `${t('pos.floor.items', { count: String(order.itemCount) })} · ${t('pos.tablesPage.open', { duration: t(duration.key, duration.values) })}`
            : t('pos.tablesPage.noOrder')}
        </p>
        {access.canManage && (
          <div className="mt-auto flex justify-end gap-2 border-t border-border pt-3">
            <TableDialog
              locationId={table.locationId}
              table={table}
              areas={areas}
              onDone={onDone}
            />
            <Button
              variant="outline"
              size="icon"
              data-testid={out ? 'table-in-service' : 'table-out-of-service'}
              aria-label={t(
                out ? 'pos.tablesPage.putInService' : 'pos.tablesPage.takeOutOfService',
                {
                  name: table.name,
                },
              )}
              onClick={() => void toggleService()}
            >
              {out ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
            </Button>
          </div>
        )}
      </Card>
    </li>
  );
}

const SEATS = /^\d{1,3}$/;

/** Add (no `table`) or edit a table: name, area, seats and its look. */
function TableDialog({
  locationId,
  table,
  areas,
  onDone,
}: {
  locationId: string;
  table?: DiningTable;
  areas: string[];
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [form, setForm] = useState({ name: '', seats: '', area: '' });
  const [shape, setShape] = useState<TableShape>('square');
  const [color, setColor] = useState<TableColor>('neutral');
  const [checked, setChecked] = useState(false);
  const seats = Number.parseInt(form.seats, 10);
  const problems = {
    name: form.name.trim() === '' ? t('pos.tablesPage.nameRequired') : null,
    seats:
      SEATS.test(form.seats.trim()) && seats >= 1 && seats <= TABLE_MAX_SEATS
        ? null
        : t('pos.tablesPage.seatsInvalid'),
  };
  const shown = (field: keyof typeof problems) => (checked ? problems[field] : null);
  const set = (field: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  return (
    <FormDialog
      trigger={t(table ? 'pos.tablesPage.editNamed' : 'pos.tablesPage.create', {
        name: table?.name ?? '',
      })}
      triggerVariant={table ? 'outline' : 'default'}
      triggerIcon={table ? <Pencil aria-hidden /> : undefined}
      testId={table ? 'table-edit' : 'table-create'}
      title={t(table ? 'pos.tablesPage.editTitle' : 'pos.tablesPage.createTitle')}
      onOpen={() => {
        setForm({
          name: table?.name ?? '',
          seats: table ? String(table.seats) : '4',
          area: table?.area ?? '',
        });
        setShape(table?.shape ?? 'square');
        setColor(table?.color ?? 'neutral');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (problems.name || problems.seats) return null;
        const body = { name: form.name.trim(), seats, area: form.area.trim(), shape, color };
        return table
          ? updateTable(store, action, table.id, body)
          : createTable(store, action, { locationId, ...body });
      }}
      onDone={onDone}
    >
      <Field id={`${id}-name`} label={t('pos.fields.name')} problem={shown('name')}>
        <Input
          id={`${id}-name`}
          value={form.name}
          maxLength={TABLE_NAME_MAX_LENGTH}
          aria-invalid={shown('name') ? true : undefined}
          onChange={(e) => set('name')(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-area`} label={t('pos.fields.area')} problem={null}>
          <Input
            id={`${id}-area`}
            list={`${id}-areas`}
            value={form.area}
            maxLength={TABLE_AREA_MAX_LENGTH}
            onChange={(e) => set('area')(e.target.value)}
          />
          <datalist id={`${id}-areas`}>
            {areas.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
        <Field id={`${id}-seats`} label={t('pos.fields.seats')} problem={shown('seats')}>
          <Input
            id={`${id}-seats`}
            inputMode="numeric"
            value={form.seats}
            aria-invalid={shown('seats') ? true : undefined}
            onChange={(e) => set('seats')(e.target.value)}
          />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">{t('pos.tablesPage.look')}</legend>
        <div className="flex items-start gap-4">
          <TableIcon shape={shape} color={color} className="size-16" />
          <div className="flex flex-col gap-3">
            <div
              role="radiogroup"
              aria-label={t('pos.tablesPage.colour')}
              className="flex flex-wrap gap-2"
            >
              {TABLE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={t(`pos.tableColors.${c}`)}
                  data-testid={`color-${c}`}
                  className={cn(
                    'size-8 rounded-full border-2',
                    color === c ? 'border-foreground' : 'border-transparent',
                  )}
                  style={{ backgroundColor: tableColors(c).stroke }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <div
              role="radiogroup"
              aria-label={t('pos.tablesPage.shape')}
              className="flex flex-wrap gap-2"
            >
              {TABLE_SHAPES.map((s) => (
                <Button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={shape === s}
                  variant={shape === s ? 'default' : 'outline'}
                  data-testid={`shape-${s}`}
                  onClick={() => setShape(s)}
                >
                  {t(`pos.tableShapes.${s}`)}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </fieldset>
    </FormDialog>
  );
}
