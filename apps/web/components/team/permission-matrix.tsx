'use client';

import type { LabelKey } from '@durby/i18n';
import { MATRIX_COLUMNS, type PermissionKey } from '@durby/shared';
import { Info, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../app/labels-provider';
import {
  blockedByView,
  canToggle,
  type MatrixCell,
  type MatrixRow as MatrixRowData,
  type MatrixSection as MatrixSectionData,
  permissionMatrix,
  tickMany,
  tickOne,
} from '../../lib/team/matrix';
import { permissionLabel, type UsersAccess } from '../../lib/users/access';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';

/**
 * The permission matrix (ADR 0050), shared by Add/Edit Staff and the Roles page editor: Select all and Clear, then
 * sections → rows → View / Create / Edit / Delete boxes with sticky column and section headers. Every tick goes
 * through `tickOne` / `tickMany` ("Grant View first"); only keys `access` holds can change. Keys of switched-off
 * modules aren't shown and stay as they are in `selected`.
 */

/** The matrix columns: the row, then View, Create, Edit and Delete (ADR 0037, ADR 0050). */
const MATRIX_GRID =
  'grid grid-cols-[minmax(0,1fr)_repeat(4,2.75rem)] items-center gap-x-1 sm:grid-cols-[minmax(0,1fr)_repeat(4,4.5rem)]';

export function PermissionMatrix({
  selected,
  onChange,
  access,
  activeFeatures,
  changed,
  changedLabel,
  actions,
  note,
}: {
  selected: ReadonlySet<string>;
  onChange: (update: (current: ReadonlySet<string>) => Set<string>) => void;
  access: UsersAccess;
  activeFeatures: readonly string[];
  /** Whether a box differs from where it started (a dot marks it). */
  changed: (key: string) => boolean;
  /** The dot's label. */
  changedLabel: LabelKey;
  /** Extra buttons before Select all (e.g. Role defaults). */
  actions?: ReactNode;
  /** A short line under the matrix. */
  note?: string;
}) {
  const t = useT();
  const { sections, hiddenModules } = permissionMatrix(activeFeatures);
  const may = (key: string) => canToggle(access, key);
  const toggleable = sections.flatMap((s) => s.keys).filter(may);

  /** One box; "Grant View first": unticking View also clears its row's actions. */
  const toggle = (key: string, on: boolean) =>
    onChange((current) => tickOne(current, key, on, may));
  /** A row, a section, Select all or Clear: only the keys you may change, actions only with their View. */
  const toggleMany = (keys: readonly string[], on: boolean) =>
    onChange((current) => tickMany(current, keys, on, may));

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {actions}
        <Button type="button" variant="outline" onClick={() => toggleMany(toggleable, true)}>
          {t('platform.team.dialog.selectAll')}
        </Button>
        <Button type="button" variant="outline" onClick={() => toggleMany(toggleable, false)}>
          {t('platform.team.dialog.clear')}
        </Button>
      </div>
      <div className="flex flex-col rounded-lg border" data-testid="team-matrix">
        <div
          className={cn(
            MATRIX_GRID,
            // Pinned while the matrix scrolls; solid so rows don't show through.
            'sticky top-0 z-20 h-9 rounded-t-lg border-b bg-card px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase',
          )}
          aria-hidden
          data-testid="team-matrix-header"
        >
          <span className="truncate">{t('platform.team.dialog.column.module')}</span>
          {MATRIX_COLUMNS.map((verb) => (
            <span
              key={verb}
              // One header height for every language: long words (de "Bearbeiten") shrink, then hyphenate.
              className="text-center text-[0.625rem] leading-tight tracking-normal hyphens-auto [overflow-wrap:anywhere] sm:text-[0.6875rem]"
              title={t(`platform.team.dialog.column.${verb}`)}
            >
              {t(`platform.team.dialog.column.${verb}`)}
            </span>
          ))}
        </div>
        <div className="flex flex-col divide-y">
          {sections.map((section) => (
            <MatrixSection
              key={section.module}
              section={section}
              selected={selected}
              access={access}
              changed={changed}
              changedLabel={changedLabel}
              onToggle={toggle}
              onToggleMany={toggleMany}
            />
          ))}
        </div>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {hiddenModules.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('platform.team.dialog.hiddenModules', {
            modules: hiddenModules.map((label) => t(label)).join(', '),
          })}
        </p>
      )}
    </>
  );
}

/** How many of the shown boxes are ticked (for the "N selected" count). */
export function shownCount(
  selected: ReadonlySet<string>,
  activeFeatures: readonly string[],
): number {
  return permissionMatrix(activeFeatures)
    .sections.flatMap((s) => s.keys)
    .filter((key) => selected.has(key)).length;
}

/** Tri-state of a set of keys: none, some or all ticked. */
function tickState(
  keys: readonly string[],
  selected: ReadonlySet<string>,
): boolean | 'indeterminate' {
  const ticked = keys.filter((key) => selected.has(key)).length;
  return ticked === 0 ? false : ticked === keys.length ? true : 'indeterminate';
}

/**
 * One module of the matrix (ADR 0050): a header whose box ticks or clears every key in it, then its rows.
 */
function MatrixSection({
  section,
  selected,
  access,
  changed,
  changedLabel,
  onToggle,
  onToggleMany,
}: {
  section: MatrixSectionData;
  selected: ReadonlySet<string>;
  access: UsersAccess;
  changed: (key: string) => boolean;
  changedLabel: LabelKey;
  onToggle: (key: string, on: boolean) => void;
  onToggleMany: (keys: readonly string[], on: boolean) => void;
}) {
  const t = useT();
  const name = t(section.label);
  return (
    <div data-testid="team-matrix-section" data-section={section.module}>
      <label
        // Sticks under the column header (h-9) until the next section pushes it up; muted over card, but solid.
        className="sticky top-9 z-10 flex min-h-11 items-center gap-2 bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))] px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        data-testid="team-matrix-section-header"
      >
        <Checkbox
          checked={tickState(section.keys, selected)}
          disabled={!section.keys.some((key) => canToggle(access, key))}
          onCheckedChange={(v) => onToggleMany(section.keys, v === true)}
          aria-label={t('platform.team.dialog.wholeSection', { section: name })}
          data-testid="team-permission-section"
          data-section={section.module}
        />
        {name}
      </label>
      <div className="flex flex-col divide-y">
        {section.rows.map((row) => (
          <MatrixRow
            key={row.row}
            row={row}
            selected={selected}
            access={access}
            changed={changed}
            changedLabel={changedLabel}
            onToggle={onToggle}
            onToggleAll={(on) => onToggleMany(row.keys, on)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One row of the matrix: the box in front ticks or clears the whole row (only the keys you may change), then a View,
 * Create, Edit and Delete cell each, a muted dash where the row has no such key.
 */
function MatrixRow({
  row,
  selected,
  access,
  changed,
  changedLabel,
  onToggle,
  onToggleAll,
}: {
  row: MatrixRowData;
  selected: ReadonlySet<string>;
  access: UsersAccess;
  changed: (key: string) => boolean;
  changedLabel: LabelKey;
  onToggle: (key: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
}) {
  const t = useT();
  const rowName = t(row.label);
  return (
    <div className={cn(MATRIX_GRID, 'px-3 py-1')} data-testid="team-matrix-row" data-area={row.row}>
      <label className="flex min-h-11 min-w-0 items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={tickState(row.keys, selected)}
          disabled={!row.keys.some((key) => canToggle(access, key))}
          onCheckedChange={(v) => onToggleAll(v === true)}
          aria-label={t('platform.team.dialog.wholeArea', { area: rowName })}
          data-testid="team-permission-area"
          data-area={row.row}
        />
        <span className="truncate" title={rowName}>
          {rowName}
        </span>
      </label>
      {MATRIX_COLUMNS.map((column) => {
        const cell = row.cells[column];
        return (
          <div key={column} className="flex justify-center" data-column={column}>
            {cell ? (
              <PermissionBox
                cell={cell}
                selected={selected}
                access={access}
                changed={changed}
                changedLabel={changedLabel}
                onToggle={onToggle}
              />
            ) : (
              <span
                className="text-sm text-muted-foreground/60"
                title={t('platform.team.dialog.noKey', {
                  column: t(`platform.team.dialog.column.${column}`),
                })}
                aria-hidden
                data-testid="team-permission-empty"
              >
                –
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One permission's box in its cell. Its full sentence is the title and accessible name; a note (the box allows more
 * than its column says, ADR 0050) shows as an info marker and is read out with the name.
 */
function PermissionBox({
  cell,
  selected,
  access,
  changed,
  changedLabel,
  onToggle,
}: {
  cell: MatrixCell;
  selected: ReadonlySet<string>;
  access: UsersAccess;
  changed: (key: string) => boolean;
  changedLabel: LabelKey;
  onToggle: (key: string, on: boolean) => void;
}) {
  const t = useT();
  const permission: PermissionKey = cell.key;
  const locked = !canToggle(access, permission);
  // "Grant View first": an unticked action whose row's View isn't ticked.
  const blocked = !locked && blockedByView(selected, permission);
  const name = t(permissionLabel(permission));
  const note = cell.note ? t(cell.note) : null;
  const described = [name, note, blocked ? t('platform.team.dialog.viewFirst') : null]
    .filter(Boolean)
    .join(' ');
  return (
    <label
      className={cn(
        'relative flex min-h-11 min-w-11 items-center justify-center text-sm',
        locked && 'text-muted-foreground',
      )}
      title={locked ? `${described} ${t('platform.team.dialog.locked')}` : described}
    >
      <Checkbox
        checked={selected.has(permission)}
        disabled={locked || blocked}
        onCheckedChange={(v) => onToggle(permission, v === true)}
        aria-label={described}
        data-blocked={blocked || undefined}
        data-testid="team-permission"
        data-key={permission}
      />
      {note && (
        <Info
          aria-hidden
          className="absolute right-0 bottom-1 size-3 text-muted-foreground"
          data-testid="team-permission-note"
        />
      )}
      {locked && <Lock aria-hidden className="absolute bottom-1 left-0 size-3" />}
      {changed(permission) && (
        <span
          className="absolute top-1.5 right-0.5 size-2 rounded-full bg-primary"
          title={t(changedLabel)}
          aria-label={t(changedLabel)}
          data-testid="team-permission-changed"
        />
      )}
    </label>
  );
}
