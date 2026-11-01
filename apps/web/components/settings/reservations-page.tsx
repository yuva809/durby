'use client';

import {
  COMBINATION_MAX_TABLES,
  COMBINATION_MIN_TABLES,
  COMBINATION_NAME_MAX_LENGTH,
  type LocationSummary,
  MAX_PARTY_SIZE,
  type ReservationCombination,
  type ReservationTable,
  type ResolvedSetting,
  type SettingKey,
  TABLE_BOOKING_MODES,
  type TableBookingMode,
  type UpdateCombinationRequest,
  type WeeklyHours,
  windowsOutside,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { Eye, EyeOff, Pencil } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import {
  createCombination,
  deleteLocationSetting,
  loadCombinations,
  loadLocationSettings,
  loadRuleTables,
  putLocationSetting,
  putTableRule,
  updateCombination,
} from '../../lib/reservations/api';
import { controlOf } from '../../lib/settings/controls';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { ArchiveToggle, Field, FormDialog } from '../form-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';
import { NoLocations } from './locations-page';
import { SettingRow, type SettingWrites } from './settings-page';

/** Name, booking mode, min, max, save: one grid for the header row and every table row. */
const RULE_GRID =
  'sm:grid sm:grid-cols-[minmax(7rem,1fr)_minmax(10rem,15rem)_5.5rem_5.5rem_6.5rem] sm:items-center sm:gap-3';

const MODE_LABELS: Record<TableBookingMode, LabelKey> = {
  all: 'reservations.bookingModes.all',
  staff_only: 'reservations.bookingModes.staffOnly',
  walk_in_only: 'reservations.bookingModes.walkInOnly',
};

/** A party size typed into a field: an int 1–100, '' when empty, or null when not a valid one. */
function partySize(text: string): number | '' | null {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= MAX_PARTY_SIZE ? n : null;
}

/**
 * /settings/reservations (docs/modules/reservations.md → Web, R1.5b): per location, the table rules
 * and the table combinations. For holders of reservations.setup.manage with the feature; the api
 * checks the key again at the location.
 */
export function ReservationsSetupPage() {
  const { store, session } = useAuth();
  const [locations, reload] = useResource(session?.activeOrganizationId ?? null, () =>
    loadLocations(store),
  );
  if (!session) return null;
  if (
    !session.activePermissions.includes('reservations.setup.manage') ||
    !session.activeFeatures.includes('reservations')
  ) {
    return <NoAccess title="reservations.settingsPage.title" />;
  }
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) => <Setup locations={list} />}
    </Loaded>
  );
}

function Setup({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? null);
  const [showArchived, setShowArchived] = useState(false);
  const [tables, reloadTables] = useResource(locationId, () =>
    loadRuleTables(store, locationId ?? ''),
  );
  const [combinations, reloadCombinations] = useResource(
    locationId === null ? null : `${locationId}:${String(showArchived)}`,
    () => loadCombinations(store, locationId ?? '', showArchived),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('reservations.settingsPage.title')}</h1>
          <p className="max-w-2xl text-muted-foreground">{t('reservations.settingsPage.intro')}</p>
        </div>
        {locations.length > 1 && locationId !== null && (
          <div className="grid min-w-56 gap-1.5">
            <Label htmlFor={`${id}-location`}>{t('reservations.settingsPage.location')}</Label>
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
      </div>

      {locationId === null ? (
        <NoLocations message={t('reservations.settingsPage.noLocations')} />
      ) : (
        <Loaded resource={tables} reload={reloadTables}>
          {(tableList) => (
            <>
              <Card className="flex flex-col gap-4 p-4 sm:p-6">
                <div className="flex flex-col gap-1">
                  <h2 className="text-lg font-semibold">{t('reservations.tablesCard.title')}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t('reservations.tablesCard.intro')}
                  </p>
                </div>
                {tableList.length === 0 ? (
                  <p className="text-muted-foreground" data-testid="rules-empty">
                    {t('reservations.tablesCard.empty')}
                  </p>
                ) : (
                  <div>
                    {/* Column heads from tablet width; each field keeps its own label for screen readers. */}
                    <div
                      aria-hidden
                      className={`hidden border-b pb-2 text-sm font-medium text-muted-foreground ${RULE_GRID}`}
                    >
                      <span />
                      <span>{t('reservations.tablesCard.bookingMode')}</span>
                      <span>{t('reservations.tablesCard.minParty')}</span>
                      <span>{t('reservations.tablesCard.maxParty')}</span>
                      <span />
                    </div>
                    <ul className="divide-y divide-border">
                      {tableList.map((table) => (
                        <RuleRow key={table.id} table={table} />
                      ))}
                    </ul>
                  </div>
                )}
              </Card>

              <Card className="flex flex-col gap-4 p-4 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-lg font-semibold">
                      {t('reservations.combinationsCard.title')}
                    </h2>
                    <p className="max-w-xl text-sm text-muted-foreground">
                      {t('reservations.combinationsCard.intro')}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      className="gap-2"
                      aria-pressed={showArchived}
                      data-testid="toggle-archived"
                      onClick={() => setShowArchived((v) => !v)}
                    >
                      {showArchived ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
                      {t(
                        showArchived
                          ? 'reservations.combinationsCard.hideArchived'
                          : 'reservations.combinationsCard.showArchived',
                      )}
                    </Button>
                    <CombinationDialog
                      locationId={locationId}
                      tables={tableList}
                      onDone={reloadCombinations}
                    />
                  </div>
                </div>
                <Loaded resource={combinations} reload={reloadCombinations}>
                  {(list) =>
                    list.length === 0 ? (
                      <p className="text-muted-foreground" data-testid="combinations-empty">
                        {t('reservations.combinationsCard.empty')}
                      </p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {list.map((combination) => (
                          <CombinationRow
                            key={combination.id}
                            combination={combination}
                            tables={tableList}
                            onDone={reloadCombinations}
                          />
                        ))}
                      </ul>
                    )
                  }
                </Loaded>
              </Card>

              <LocationSettings
                locationId={locationId}
                locationName={locations.find((l) => l.id === locationId)?.name ?? ''}
              />
            </>
          )}
        </Loaded>
      )}
    </div>
  );
}

interface RuleDraft {
  bookingMode: TableBookingMode;
  min: string;
  max: string;
}

const draftOf = (table: ReservationTable): RuleDraft => ({
  bookingMode: table.bookingMode,
  min: String(table.minParty),
  max: table.maxParty === null ? '' : String(table.maxParty),
});

/** One table: booking mode and party range, saved per row. */
function RuleRow({ table: loaded }: { table: ReservationTable }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [table, setTable] = useState(loaded);
  const [draft, setDraft] = useState(() => draftOf(loaded));
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(table));
  const max = partySize(draft.max);
  const overSeats = typeof max === 'number' && max > table.seats;

  function change(next: Partial<RuleDraft>) {
    setDraft((d) => ({ ...d, ...next }));
    setProblem(null);
    setError(null);
    setSaved(false);
  }

  async function save() {
    const min = partySize(draft.min);
    if (typeof min !== 'number' || max === null) {
      setProblem(t('reservations.tablesCard.numberProblem'));
      return;
    }
    const capacity = max === '' ? table.seats : max;
    if (min > capacity) {
      setProblem(t('reservations.tablesCard.rangeProblem', { max: String(capacity) }));
      return;
    }
    setBusy(true);
    const result = await putTableRule(store, action, table.id, {
      bookingMode: draft.bookingMode,
      minParty: min,
      maxParty: max === '' ? null : max,
    });
    setBusy(false);
    if (result.ok && result.data) {
      setTable(result.data);
      setDraft(draftOf(result.data));
      setSaved(true);
    } else {
      setError(t(errorLabel(result.ok ? 'unknown' : result.code)));
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3" data-testid="rule-row" data-name={table.name}>
      <div className={`flex flex-wrap items-end gap-3 ${RULE_GRID}`}>
        <div className="flex w-full flex-col sm:w-auto">
          <span className="font-medium">{table.name}</span>
          <span className="text-sm text-muted-foreground">
            {[t('reservations.tablesCard.seats', { count: String(table.seats) }), table.area]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <div className="grid w-full gap-1.5 sm:w-auto">
          <Label htmlFor={`${id}-mode`} className="sm:sr-only">
            {t('reservations.tablesCard.bookingMode')}
          </Label>
          <Select
            id={`${id}-mode`}
            value={draft.bookingMode}
            onChange={(e) => change({ bookingMode: e.target.value as TableBookingMode })}
          >
            {TABLE_BOOKING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(MODE_LABELS[mode])}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid w-24 gap-1.5 sm:w-auto">
          <Label htmlFor={`${id}-min`} className="sm:sr-only">
            {t('reservations.tablesCard.minParty')}
          </Label>
          <Input
            id={`${id}-min`}
            inputMode="numeric"
            value={draft.min}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
            onChange={(e) => change({ min: e.target.value })}
          />
        </div>
        <div className="grid w-24 gap-1.5 sm:w-auto">
          <Label htmlFor={`${id}-max`} className="sm:sr-only">
            {t('reservations.tablesCard.maxParty')}
          </Label>
          <Input
            id={`${id}-max`}
            inputMode="numeric"
            placeholder={String(table.seats)}
            value={draft.max}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
            onChange={(e) => change({ max: e.target.value })}
          />
        </div>
        <Button
          variant={dirty ? 'default' : 'outline'}
          disabled={!dirty || busy}
          aria-label={t('reservations.tablesCard.saveFor', { name: table.name })}
          className="sm:w-full"
          data-testid="rule-save"
          onClick={() => void save()}
        >
          {t('reservations.tablesCard.save')}
        </Button>
      </div>
      {problem && (
        <p id={`${id}-problem`} role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {!problem && overSeats && (
        <p className="text-sm text-muted-foreground">
          {t('reservations.tablesCard.overSeats', { seats: String(table.seats) })}
        </p>
      )}
      {saved && !dirty && (
        <p className="text-sm text-muted-foreground" role="status">
          {t('reservations.tablesCard.saved')}
        </p>
      )}
      <Notice text={error} tone="error" />
    </li>
  );
}

function CombinationRow({
  combination,
  tables,
  onDone,
}: {
  combination: ReservationCombination;
  tables: ReservationTable[];
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const byId = new Map(tables.map((x) => [x.id, x]));
  const names = combination.tableIds.map(
    (tableId) => byId.get(tableId)?.name ?? t('reservations.combinationsCard.unknownTable'),
  );
  const archived = combination.archivedAt !== null;
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 py-4"
      data-testid="combination-row"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{combination.name}</span>
          {!combination.onlineBookable && (
            <Badge>{t('reservations.combinationsCard.staffOnly')}</Badge>
          )}
          {archived && <Badge>{t('reservations.combinationsCard.archived')}</Badge>}
        </span>
        <span className="text-sm text-muted-foreground">
          {names.join(' + ')} ·{' '}
          {t('reservations.combinationsCard.guests', {
            min: String(combination.minParty),
            max: String(combination.maxParty),
          })}
        </span>
      </div>
      <span className="flex shrink-0 gap-2">
        {!archived && (
          <CombinationDialog
            locationId={combination.locationId}
            tables={tables}
            combination={combination}
            onDone={onDone}
          />
        )}
        <ArchiveToggle
          archived={archived}
          labels={{
            archive: t('reservations.combinationsCard.archive'),
            unarchive: t('reservations.combinationsCard.unarchive'),
            title: t('reservations.combinationsCard.archiveTitle', { name: combination.name }),
            description: t('reservations.combinationsCard.archiveDescription'),
          }}
          run={(next) => updateCombination(store, action, combination.id, { archived: next })}
          onDone={onDone}
        />
      </span>
    </li>
  );
}

/**
 * Add (no `combination`) or edit a combination. The tables offered are `tables`: the location's
 * tables in service (GET /reservations/tables), never another location's.
 */
function CombinationDialog({
  locationId,
  tables,
  combination,
  onDone,
}: {
  locationId: string;
  tables: ReservationTable[];
  combination?: ReservationCombination;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [online, setOnline] = useState(true);
  const [checked, setChecked] = useState(false);

  const inService = new Set(tables.map((x) => x.id));
  const hasOutOfService = combination?.tableIds.some((x) => !inService.has(x)) ?? false;
  const minValue = partySize(min);
  const maxValue = partySize(max);
  const seats = tables.filter((x) => selected.includes(x.id)).reduce((s, x) => s + x.seats, 0);

  const nameProblem =
    checked && name.trim() === '' ? t('reservations.combinationsCard.nameRequired') : null;
  const tablesProblem =
    checked &&
    (selected.length < COMBINATION_MIN_TABLES || selected.length > COMBINATION_MAX_TABLES)
      ? t('reservations.combinationsCard.tablesProblem')
      : null;
  const minProblem =
    checked && typeof minValue !== 'number' ? t('reservations.tablesCard.numberProblem') : null;
  let maxProblem =
    checked && typeof maxValue !== 'number' ? t('reservations.tablesCard.numberProblem') : null;
  if (
    checked &&
    !maxProblem &&
    typeof minValue === 'number' &&
    typeof maxValue === 'number' &&
    minValue > maxValue
  ) {
    maxProblem = t('reservations.tablesCard.rangeProblem', { max: String(maxValue) });
  }
  const overSeats = typeof maxValue === 'number' && selected.length > 0 && maxValue > seats;

  function submit() {
    setChecked(true);
    const trimmed = name.trim();
    if (
      trimmed === '' ||
      selected.length < COMBINATION_MIN_TABLES ||
      selected.length > COMBINATION_MAX_TABLES ||
      typeof minValue !== 'number' ||
      typeof maxValue !== 'number' ||
      minValue > maxValue
    ) {
      return null;
    }
    // Table order follows the floor (the rules list), so the request is stable.
    const tableIds = tables.filter((x) => selected.includes(x.id)).map((x) => x.id);
    if (!combination) {
      return createCombination(store, action, {
        locationId,
        name: trimmed,
        tableIds,
        minParty: minValue,
        maxParty: maxValue,
        onlineBookable: online,
      });
    }
    const body: UpdateCombinationRequest = {};
    if (trimmed !== combination.name) body.name = trimmed;
    if ([...tableIds].sort().join() !== [...combination.tableIds].sort().join()) {
      body.tableIds = tableIds;
    }
    if (minValue !== combination.minParty) body.minParty = minValue;
    if (maxValue !== combination.maxParty) body.maxParty = maxValue;
    if (online !== combination.onlineBookable) body.onlineBookable = online;
    if (Object.keys(body).length === 0) return Promise.resolve({ ok: true as const, data: null });
    return updateCombination(store, action, combination.id, body);
  }

  return (
    <FormDialog
      trigger={
        combination
          ? t('reservations.combinationsCard.edit', { name: combination.name })
          : t('reservations.combinationsCard.add')
      }
      triggerVariant={combination ? 'outline' : 'default'}
      triggerIcon={combination ? <Pencil aria-hidden /> : undefined}
      testId={combination ? 'combination-edit' : 'combination-create'}
      title={t(
        combination
          ? 'reservations.combinationsCard.editTitle'
          : 'reservations.combinationsCard.addTitle',
      )}
      onOpen={() => {
        setName(combination?.name ?? '');
        setSelected(combination ? combination.tableIds.filter((x) => inService.has(x)) : []);
        setMin(combination ? String(combination.minParty) : '');
        setMax(combination ? String(combination.maxParty) : '');
        setOnline(combination?.onlineBookable ?? true);
        setChecked(false);
      }}
      submit={submit}
      onDone={onDone}
    >
      <Field
        id={`${id}-name`}
        label={t('reservations.combinationsCard.name')}
        problem={nameProblem}
      >
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={COMBINATION_NAME_MAX_LENGTH}
          aria-invalid={nameProblem ? true : undefined}
          aria-describedby={nameProblem ? `${id}-name-problem` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">
          {t('reservations.combinationsCard.tables')}
        </legend>
        <div className="grid max-h-64 gap-1 overflow-y-auto sm:grid-cols-2">
          {tables.map((table) => {
            const label = t('reservations.combinationsCard.tableOption', {
              name: table.name,
              seats: String(table.seats),
            });
            return (
              <div
                key={table.id}
                className="flex min-h-11 items-center gap-3 rounded-md px-2 hover:bg-muted"
                data-testid="combination-table"
              >
                <Checkbox
                  id={`${id}-table-${table.id}`}
                  checked={selected.includes(table.id)}
                  onCheckedChange={(on) =>
                    setSelected((current) =>
                      on === true ? [...current, table.id] : current.filter((x) => x !== table.id),
                    )
                  }
                />
                <Label htmlFor={`${id}-table-${table.id}`} className="flex-1 cursor-pointer py-2">
                  {label}
                </Label>
              </div>
            );
          })}
        </div>
        {tablesProblem && (
          <p role="alert" className="text-sm text-destructive">
            {tablesProblem}
          </p>
        )}
        {hasOutOfService && (
          <p className="text-sm text-muted-foreground">
            {t('reservations.combinationsCard.notInService')}
          </p>
        )}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field id={`${id}-min`} label={t('reservations.tablesCard.minParty')} problem={minProblem}>
          <Input
            id={`${id}-min`}
            inputMode="numeric"
            value={min}
            aria-invalid={minProblem ? true : undefined}
            aria-describedby={minProblem ? `${id}-min-problem` : undefined}
            onChange={(e) => setMin(e.target.value)}
          />
        </Field>
        <Field id={`${id}-max`} label={t('reservations.tablesCard.maxParty')} problem={maxProblem}>
          <Input
            id={`${id}-max`}
            inputMode="numeric"
            value={max}
            aria-invalid={maxProblem ? true : undefined}
            aria-describedby={maxProblem ? `${id}-max-problem` : undefined}
            onChange={(e) => setMax(e.target.value)}
          />
        </Field>
      </div>
      {overSeats && (
        <p className="text-sm text-muted-foreground">
          {t('reservations.combinationsCard.overSeats', { seats: String(seats) })}
        </p>
      )}
      <div className="flex min-h-11 items-center gap-3">
        <Checkbox
          id={`${id}-online`}
          checked={online}
          onCheckedChange={(on) => setOnline(on === true)}
        />
        <Label htmlFor={`${id}-online`} className="cursor-pointer">
          {t('reservations.combinationsCard.onlineBookable')}
        </Label>
      </div>
    </FormDialog>
  );
}

/**
 * The location's own reservations.* settings (R1.5c, ADR 0020): set here or inherited from the
 * organization. Opening hours and closed days stay on the General tab (platform.settings.manage).
 */
function LocationSettings({
  locationId,
  locationName,
}: {
  locationId: string;
  locationName: string;
}) {
  const t = useT();
  const { store } = useAuth();
  const [resource, reload] = useResource(locationId, () => loadLocationSettings(store, locationId));
  // Saved rows replace their loaded value until the location changes.
  const [saved, setSaved] = useState<{
    locationId: string;
    rows: Partial<Record<SettingKey, ResolvedSetting>>;
  }>({ locationId, rows: {} });
  const rows = saved.locationId === locationId ? saved.rows : {};
  const writes: SettingWrites = {
    scope: 'location',
    put: (action, key, value) => putLocationSetting(store, action, locationId, key, value),
    remove: (action, key) => deleteLocationSetting(store, action, locationId, key),
    reload: async (key) => {
      const reloaded = await loadLocationSettings(store, locationId);
      return reloaded.ok ? reloaded.data.data.find((x) => x.key === key) : undefined;
    },
  };

  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-6" data-testid="location-settings">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t('reservations.locationSettings.title')}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('reservations.locationSettings.intro', { location: locationName })}
        </p>
      </div>
      <Loaded resource={resource} reload={reload}>
        {({ data, openingHours }) => (
          <ul className="flex flex-col gap-3">
            {data.map((loaded) => {
              const setting = rows[loaded.key] ?? loaded;
              const control = controlOf(setting.key);
              if (!control) return null;
              return (
                <li key={`${locationId}:${setting.key}`}>
                  <SettingRow
                    setting={setting}
                    control={control}
                    openingHours={openingHours}
                    writes={writes}
                    editable
                    onSaved={(next) =>
                      setSaved({ locationId, rows: { ...rows, [next.key]: next } })
                    }
                    below={
                      setting.key === 'reservations.serviceHours'
                        ? (draft) => (
                            <OutsideOpeningHours draft={draft} openingHours={openingHours} />
                          )
                        : undefined
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Loaded>
    </Card>
  );
}

/** Which parts of a service-hours schedule fall outside the opening hours (saved, never offered). */
function OutsideOpeningHours({
  draft,
  openingHours,
}: {
  draft: unknown;
  openingHours: WeeklyHours;
}) {
  const t = useT();
  if (typeof draft !== 'object' || draft === null) return null;
  const outside = windowsOutside(draft as WeeklyHours, openingHours);
  if (outside.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="service-outside">
      <p className="font-medium">{t('reservations.locationSettings.outsideIntro')}</p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {outside.map((w) => (
          <li key={`${w.day}-${w.from}`}>
            {t('reservations.locationSettings.outside', {
              day: t(`platform.settingsPage.weekdays.${w.day}`),
              from: w.from,
              to: w.to,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
