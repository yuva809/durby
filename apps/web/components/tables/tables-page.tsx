'use client';

import {
  AREA_NAME_MAX_LENGTH,
  type DiningArea,
  type DiningTable,
  type FloorTable,
  type LocationSummary,
  TABLE_COLORS,
  TABLE_MAX_SEATS,
  TABLE_NAME_MAX_LENGTH,
  TABLE_SHAPES,
  type TableColor,
  type TableShape,
} from '@durby/shared';
import { Eye, EyeOff, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  createArea,
  createTable,
  deleteArea,
  loadAreas,
  loadFloor,
  loadTables,
  updateArea,
  updateTable,
} from '../../lib/pos/api';
import { durationLabel, minutesSince } from '../../lib/pos/format';
import { useNow } from '../../lib/pos/use-now';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { TableIcon, tableColors } from '../pos/table-icon';
import { QrDialog } from './qr-dialog';
import { NoLocations } from '../settings/locations-page';
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

interface Access {
  canManage: boolean;
  /** pos.orders.read: show which tables are occupied. */
  canSeeOrders: boolean;
}

/**
 * /tables: the floor plan admin (docs/modules/pos.md → Web), apart from the POS screens. Areas with
 * their tables, each drawn in its look with its status; "out of service" tables are the archived
 * ones.
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
            <NoLocations message={t('pos.tablesPage.noLocations')} />
          </div>
        ) : (
          <LocationTables locations={list} access={access} />
        )
      }
    </Loaded>
  );
}

type AreaFilter = { kind: 'all' } | { kind: 'none' } | { kind: 'area'; id: string };

function LocationTables({ locations, access }: { locations: LocationSummary[]; access: Access }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]!.id);
  const [query, setQuery] = useState('');
  const [showOut, setShowOut] = useState(false);
  const [filter, setFilter] = useState<AreaFilter>({ kind: 'all' });
  const [tables, reloadTables] = useResource(locationId, () => loadTables(store, locationId, true));
  const [areas, reloadAreas] = useResource(locationId, () => loadAreas(store, locationId));
  const [floor, reloadFloor] = useResource(access.canSeeOrders ? locationId : null, () =>
    loadFloor(store, locationId),
  );
  const reload = () => {
    reloadTables();
    reloadAreas();
    if (access.canSeeOrders) reloadFloor();
  };
  const now = useNow(30_000);

  const orders = new Map(
    floor.status === 'ready' ? floor.data.map((x) => [x.id, x.order] as const) : [],
  );
  const all = tables.status === 'ready' ? tables.data : [];
  const areaList = areas.status === 'ready' ? areas.data : [];
  const inService = all.filter((x) => x.archivedAt === null);
  const outOfService = all.length - inService.length;
  const occupied = inService.filter((x) => orders.get(x.id)).length;
  const selectedArea =
    filter.kind === 'area' ? areaList.find((a) => a.id === filter.id) : undefined;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('pos.nav.tables')}</h1>
          <p className="text-sm text-muted-foreground">{t('pos.tablesPage.description')}</p>
          <p
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"
            data-testid="table-kpis"
          >
            <Stat
              dot="bg-muted-foreground"
              label={t('pos.tablesPage.kpiInService')}
              value={inService.length}
            />
            {access.canSeeOrders && (
              <>
                <Stat
                  dot="bg-border"
                  label={t('pos.tablesPage.kpiAvailable')}
                  value={inService.length - occupied}
                />
                <Stat dot="bg-primary" label={t('pos.tablesPage.kpiOccupied')} value={occupied} />
              </>
            )}
            <Stat
              dot="bg-destructive"
              label={t('pos.tablesPage.kpiOutOfService')}
              value={outOfService}
            />
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {locations.length > 1 && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-location`}>{t('pos.tablesPage.location')}</Label>
              <Select
                id={`${id}-location`}
                data-testid="location-select"
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  setFilter({ kind: 'all' });
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
          {access.canManage && (
            <TableDialog
              locationId={locationId}
              areas={areaList}
              defaultArea={selectedArea}
              primary
              onDone={reload}
            />
          )}
        </div>
      </div>

      <Loaded resource={areas} reload={reloadAreas}>
        {(areaRows) => (
          <AreaTabs
            areas={areaRows}
            tables={all.filter((x) => showOut || x.archivedAt === null)}
            filter={filter}
            onFilter={setFilter}
            access={access}
            locationId={locationId}
            onDone={reload}
          />
        )}
      </Loaded>

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
          variant="ghost"
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
          <FloorGrid
            tables={list.filter((x) => {
              if (!showOut && x.archivedAt !== null) return false;
              if (filter.kind === 'none' && x.areaId !== null) return false;
              if (filter.kind === 'area' && x.areaId !== filter.id) return false;
              const needle = query.trim().toLocaleLowerCase();
              return (
                needle === '' ||
                [x.name, x.area ?? ''].some((s) => s.toLocaleLowerCase().includes(needle))
              );
            })}
            emptyArea={selectedArea !== undefined}
            orders={orders}
            now={now}
            access={access}
            areas={areaList}
            onDone={reload}
            canManage={access.canManage}
            onMove={async (table, floorX, floorY) => {
              const result = await updateTable(store, action, table.id, { floorX, floorY });
              if (result.ok) reloadTables();
            }}
          />
        )}
      </Loaded>
    </div>
  );
}

function Stat({ dot, label, value }: { dot: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2 rounded-full', dot)} />
      <span>{label}</span>
      <span className="font-semibold text-foreground tabular-nums">{value}</span>
    </span>
  );
}

/**
 * Areas as tabs (All, each area, No area) with their table counts, and Add area; the selected area's
 * tools (add a table there, rename, delete) next to them.
 */
function AreaTabs({
  areas,
  tables,
  filter,
  onFilter,
  access,
  locationId,
  onDone,
}: {
  areas: DiningArea[];
  tables: DiningTable[];
  filter: AreaFilter;
  onFilter: (filter: AreaFilter) => void;
  access: Access;
  locationId: string;
  onDone: () => void;
}) {
  const t = useT();
  const loose = tables.filter((x) => x.areaId === null).length;
  const selected = filter.kind === 'area' ? areas.find((a) => a.id === filter.id) : undefined;
  const tab = (key: string, label: string, count: number, active: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      role="tab"
      aria-selected={active}
      data-testid="area-tab"
      data-name={label}
      onClick={onClick}
      className={cn(
        '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors',
        active
          ? 'border-primary font-semibold text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{count}</span>
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2 border-b border-border">
        <div
          role="tablist"
          aria-label={t('pos.tablesPage.areas')}
          className="flex min-w-0 flex-1 overflow-x-auto"
        >
          {tab('all', t('pos.tablesPage.allAreas'), tables.length, filter.kind === 'all', () =>
            onFilter({ kind: 'all' }),
          )}
          {areas.map((a) =>
            tab(
              a.id,
              a.name,
              tables.filter((x) => x.areaId === a.id).length,
              filter.kind === 'area' && filter.id === a.id,
              () => onFilter({ kind: 'area', id: a.id }),
            ),
          )}
          {loose > 0 &&
            tab('none', t('pos.areas.none'), loose, filter.kind === 'none', () =>
              onFilter({ kind: 'none' }),
            )}
        </div>
        {access.canManage && (
          <div className="pb-1.5">
            <AreaDialog locationId={locationId} onDone={onDone} />
          </div>
        )}
      </div>
      {access.canManage && selected && (
        <div className="flex flex-wrap items-center gap-2" data-testid="area-actions">
          <span className="text-sm text-muted-foreground">{selected.name}</span>
          <AreaDialog locationId={selected.locationId} area={selected} onDone={onDone} />
          <DeleteArea
            area={selected}
            empty={!tables.some((x) => x.areaId === selected.id) && selected.tableCount === 0}
            onDone={() => {
              onFilter({ kind: 'all' });
              onDone();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The tables as a floor plan: square tiles with the table drawn in its shape and colour. */
function FloorGrid({
  tables,
  emptyArea,
  orders,
  now,
  access,
  areas,
  onDone,
  canManage,
  onMove,
}: {
  tables: DiningTable[];
  emptyArea: boolean;
  orders: ReadonlyMap<string, FloorTable['order'] | undefined>;
  now: number;
  access: Access;
  areas: DiningArea[];
  onDone: () => void;
  canManage: boolean;
  onMove: (table: DiningTable, floorX: number, floorY: number) => Promise<void>;
}) {
  const t = useT();
  const canvas = useRef<HTMLUListElement>(null);
  if (tables.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-muted-foreground">
        {t(emptyArea ? 'pos.areas.empty' : 'pos.tablesPage.empty')}
      </p>
    );
  }
  return (
    <ul
      ref={canvas}
      className="relative min-h-[620px] overflow-hidden rounded-2xl border border-border bg-card/50"
      style={{
        backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      {tables.map((table) => (
        <TableTile
          key={table.id}
          table={table}
          order={orders.get(table.id) ?? null}
          now={now}
          access={access}
          areas={areas}
          onDone={onDone}
          canManage={canManage}
          onMove={onMove}
          canvas={canvas}
        />
      ))}
    </ul>
  );
}

function TableTile({
  table,
  order,
  now,
  access,
  areas,
  onDone,
  canManage,
  onMove,
  canvas,
}: {
  table: DiningTable;
  order: FloorTable['order'];
  now: number;
  access: Access;
  areas: DiningArea[];
  onDone: () => void;
  canManage: boolean;
  onMove: (table: DiningTable, floorX: number, floorY: number) => Promise<void>;
  canvas: React.RefObject<HTMLUListElement | null>;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const out = table.archivedAt !== null;
  const status = out ? 'outOfService' : order ? 'occupied' : 'available';
  const statusLabel = {
    outOfService: t('pos.tablesPage.status.outOfService'),
    occupied: t('pos.tablesPage.status.occupied'),
    available: t('pos.tablesPage.status.available'),
  }[status];
  const duration = order ? durationLabel(minutesSince(order.openedAt, now)) : null;
  const { stroke, fill } = tableColors(table.color);
  const drag = useRef<{ pointer: number; moved: boolean } | null>(null);

  function move(event: React.PointerEvent<HTMLLIElement>) {
    if (!drag.current || !canvas.current) return;
    drag.current.moved = true;
    const bounds = canvas.current.getBoundingClientRect();
    const floorX = Math.max(
      0,
      Math.min(1000, Math.round(((event.clientX - bounds.left) / bounds.width) * 1000)),
    );
    const floorY = Math.max(
      0,
      Math.min(1000, Math.round(((event.clientY - bounds.top) / bounds.height) * 1000)),
    );
    event.currentTarget.style.left = `${floorX / 10}%`;
    event.currentTarget.style.top = `${floorY / 10}%`;
  }

  async function toggleService() {
    const result = await updateTable(store, action, table.id, { archived: !out });
    if (result.ok) onDone();
  }

  return (
    <li
      data-testid="table-card"
      data-name={table.name}
      data-status={status}
      style={{
        position: 'absolute',
        left: `${table.floorX / 10}%`,
        top: `${table.floorY / 10}%`,
        transform: 'translate(-50%, -50%)',
        width: 148,
        touchAction: 'none',
        cursor: canManage ? 'grab' : undefined,
      }}
      onPointerDown={(event) => {
        if (!canManage || (event.target as HTMLElement).closest('button')) return;
        drag.current = { pointer: event.pointerId, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        if (!drag.current || !drag.current.moved) {
          drag.current = null;
          return;
        }
        const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
        const floorX = Math.max(
          0,
          Math.min(1000, Math.round(((event.clientX - bounds.left) / bounds.width) * 1000)),
        );
        const floorY = Math.max(
          0,
          Math.min(1000, Math.round(((event.clientY - bounds.top) / bounds.height) * 1000)),
        );
        drag.current = null;
        void onMove(table, floorX, floorY);
      }}
    >
      <div
        className={cn(
          'relative flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border-2 bg-card p-3 text-center transition-shadow hover:shadow-md',
          out && 'border-dashed opacity-60',
        )}
        style={{
          borderColor: order ? stroke : undefined,
          backgroundColor: order ? fill : undefined,
        }}
      >
        <TableIcon shape={table.shape} color={table.color} className="size-14" />
        <span className="text-lg font-semibold leading-tight">{table.name}</span>
        <span className="text-xs text-muted-foreground">
          {t('pos.floor.seats', { count: String(table.seats) })}
          {table.area && ` · ${table.area}`}
        </span>
        <span className="mt-1 text-xs font-medium">
          {order && duration
            ? `${t('pos.floor.items', { count: String(order.itemCount) })} · ${t('pos.tablesPage.open', { duration: t(duration.key, duration.values) })}`
            : order === null && !out
              ? t('pos.tablesPage.noOrder')
              : statusLabel}
        </span>
        <span className="sr-only">{statusLabel}</span>
        {!out && (
          <div className="absolute top-2 left-2">
            <QrDialog table={table} canManage={access.canManage} onDone={onDone} />
          </div>
        )}
        {access.canManage && (
          <div className="absolute top-2 right-2 flex gap-1">
            <TableDialog
              locationId={table.locationId}
              table={table}
              areas={areas}
              onDone={onDone}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('pos.tablesPage.actions', { name: table.name })}
                  data-testid="table-menu"
                >
                  <MoreHorizontal aria-hidden className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  data-testid={out ? 'table-in-service' : 'table-out-of-service'}
                  onSelect={() => void toggleService()}
                >
                  {out ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
                  {t(out ? 'pos.tablesPage.putInService' : 'pos.tablesPage.takeOutOfService', {
                    name: table.name,
                  })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </li>
  );
}

function DeleteArea({
  area,
  empty,
  onDone,
}: {
  area: DiningArea;
  empty: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  if (!empty) {
    // Only an empty area can be deleted (also no table out of service): say why instead.
    return (
      <Button
        variant="outline"
        size="icon"
        disabled
        aria-label={`${t('pos.areas.delete', { name: area.name })}: ${t('pos.areas.notEmptyHint')}`}
        title={t('pos.areas.notEmptyHint')}
        data-testid="area-delete"
      >
        <Trash2 aria-hidden />
      </Button>
    );
  }
  return (
    <ConfirmAction
      testId="area-delete"
      trigger={t('pos.areas.delete', { name: area.name })}
      triggerIcon={<Trash2 aria-hidden />}
      title={t('pos.areas.deleteTitle', { name: area.name })}
      description={t('pos.areas.deleteDescription')}
      confirm={t('pos.areas.deleteConfirm')}
      run={() => deleteArea(store, action, area.id)}
      onDone={onDone}
    />
  );
}

/** Add (no `area`) or rename an area. */
function AreaDialog({
  locationId,
  area,
  onDone,
}: {
  locationId: string;
  area?: DiningArea;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [name, setName] = useState('');
  const [checked, setChecked] = useState(false);
  const problem = checked && name.trim() === '' ? t('pos.areas.nameRequired') : null;
  return (
    <FormDialog
      trigger={area ? t('pos.areas.rename', { name: area.name }) : t('pos.areas.add')}
      triggerVariant="outline"
      triggerIcon={area ? <Pencil aria-hidden /> : undefined}
      testId={area ? 'area-rename' : 'area-create'}
      title={t(area ? 'pos.areas.renameTitle' : 'pos.areas.addTitle')}
      onOpen={() => {
        setName(area?.name ?? '');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '') return null;
        return area
          ? updateArea(store, action, area.id, { name: name.trim() })
          : createArea(store, action, { locationId, name: name.trim() });
      }}
      onDone={onDone}
    >
      <Field id={`${id}-name`} label={t('pos.areas.name')} problem={problem}>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={AREA_NAME_MAX_LENGTH}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

const SEATS = /^\d{1,3}$/;

/**
 * Add (no `table`: the header's "New table") or edit a table (a tile's pencil): name, area, seats and
 * its look. `defaultArea`: a new table starts in the area whose tab is selected.
 */
function TableDialog({
  locationId,
  table,
  areas,
  defaultArea,
  onDone,
}: {
  locationId: string;
  table?: DiningTable;
  areas: DiningArea[];
  defaultArea?: DiningArea;
  /** The header's button (the only way to add a table). */
  primary?: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [form, setForm] = useState({ name: '', seats: '', areaId: '' });
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
  const here = areas.filter((a) => a.locationId === locationId);

  const trigger = table
    ? t('pos.tablesPage.editNamed', { name: table.name })
    : t('pos.tablesPage.create');

  return (
    <FormDialog
      trigger={trigger}
      triggerVariant={table ? 'ghost' : 'default'}
      triggerIcon={table ? <Pencil aria-hidden className="size-4" /> : undefined}
      triggerClassName={table ? 'size-8' : undefined}
      testId={table ? 'table-edit' : 'table-create'}
      title={t(table ? 'pos.tablesPage.editTitle' : 'pos.tablesPage.createTitle')}
      onOpen={() => {
        setForm({
          name: table?.name ?? '',
          seats: table ? String(table.seats) : '4',
          areaId: table ? (table.areaId ?? '') : (defaultArea?.id ?? ''),
        });
        setShape(table?.shape ?? 'square');
        setColor(table?.color ?? 'neutral');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (problems.name || problems.seats) return null;
        const body = {
          name: form.name.trim(),
          seats,
          areaId: form.areaId === '' ? null : form.areaId,
          shape,
          color,
        };
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
          <Select
            id={`${id}-area`}
            value={form.areaId}
            onChange={(e) => set('areaId')(e.target.value)}
          >
            <option value="">{t('pos.areas.none')}</option>
            {here.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
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
