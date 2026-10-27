'use client';

import {
  type DiningTable,
  type LocationSummary,
  TABLE_AREA_MAX_LENGTH,
  TABLE_MAX_SEATS,
  TABLE_NAME_MAX_LENGTH,
} from '@durby/shared';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createTable, loadTables, updateTable } from '../../lib/pos/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { ArchiveToggle, Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';

/**
 * /pos/tables (docs/modules/pos.md → Step 1). The session says whether the user may manage tables
 * somewhere; the api checks it per location and answers 403 elsewhere.
 */
export function TablesPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('pos.tables.read')) return <NoAccess title="pos.nav.tables" />;
  return (
    <Tables
      organizationId={session.activeOrganizationId}
      canManage={permissions.has('pos.tables.manage')}
    />
  );
}

function Tables({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [locations, reloadLocations] = useResource(organizationId, () => loadLocations(store));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('pos.nav.tables')}</h1>
      <Loaded resource={locations} reload={reloadLocations}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">{t('pos.tablesPage.noLocations')}</p>
          ) : (
            <LocationTables locations={list} canManage={canManage} />
          )
        }
      </Loaded>
    </div>
  );
}

function LocationTables({
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
  const [showArchived, setShowArchived] = useState(false);
  const [tables, reload] = useResource(`${locationId}:${showArchived}`, () =>
    loadTables(store, locationId, showArchived),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
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
          <div className="flex min-h-11 items-center gap-3">
            <Checkbox
              id={`${id}-archived`}
              checked={showArchived}
              onCheckedChange={(next) => setShowArchived(next === true)}
            />
            <Label htmlFor={`${id}-archived`} className="font-normal">
              {t('pos.tablesPage.showArchived')}
            </Label>
          </div>
        </div>
        {canManage && <TableDialog locationId={locationId} onDone={reload} />}
      </div>
      <Loaded resource={tables} reload={reload}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">{t('pos.tablesPage.empty')}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {list.map((table) => (
                <TableCard key={table.id} table={table} canManage={canManage} onDone={reload} />
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}

function TableCard({
  table,
  canManage,
  onDone,
}: {
  table: DiningTable;
  canManage: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <li data-testid="table-card" data-name={table.name}>
      <Card className="flex h-full flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">{table.name}</h2>
          {table.archivedAt && <Badge>{t('pos.tablesPage.archived')}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {t('pos.tablesPage.seatsCount', { count: String(table.seats) })}
          {table.area && ` · ${table.area}`}
        </p>
        {canManage && (
          <div className="mt-auto flex flex-wrap gap-2">
            <TableDialog locationId={table.locationId} table={table} onDone={onDone} />
            <ArchiveToggle
              archived={table.archivedAt !== null}
              labels={{
                archive: t('pos.tablesPage.archive'),
                unarchive: t('pos.tablesPage.unarchive'),
                title: t('pos.tablesPage.archiveTitle'),
                description: t('pos.tablesPage.archiveDescription', { name: table.name }),
              }}
              run={(archived) => updateTable(store, action, table.id, { archived })}
              onDone={onDone}
            />
          </div>
        )}
      </Card>
    </li>
  );
}

const SEATS = /^\d{1,3}$/;

/** Create (no `table`) or edit a table at `locationId`. */
function TableDialog({
  locationId,
  table,
  onDone,
}: {
  locationId: string;
  table?: DiningTable;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [form, setForm] = useState({ name: '', seats: '', area: '' });
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
      trigger={t(table ? 'pos.tablesPage.edit' : 'pos.tablesPage.create')}
      triggerVariant={table ? 'outline' : 'default'}
      testId={table ? 'table-edit' : 'table-create'}
      title={t(table ? 'pos.tablesPage.editTitle' : 'pos.tablesPage.createTitle')}
      onOpen={() => {
        setForm({
          name: table?.name ?? '',
          seats: table ? String(table.seats) : '4',
          area: table?.area ?? '',
        });
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (problems.name || problems.seats) return null;
        const body = { name: form.name.trim(), seats, area: form.area.trim() };
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
      <Field id={`${id}-seats`} label={t('pos.fields.seats')} problem={shown('seats')}>
        <Input
          id={`${id}-seats`}
          inputMode="numeric"
          value={form.seats}
          aria-invalid={shown('seats') ? true : undefined}
          onChange={(e) => set('seats')(e.target.value)}
        />
      </Field>
      <Field id={`${id}-area`} label={t('pos.fields.area')} problem={null}>
        <Input
          id={`${id}-area`}
          value={form.area}
          maxLength={TABLE_AREA_MAX_LENGTH}
          onChange={(e) => set('area')(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
