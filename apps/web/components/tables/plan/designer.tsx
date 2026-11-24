'use client';

import {
  type AreaFloorPlanResponse,
  type DiningTable,
  FLOOR_PLAN_PIECES,
  type FloorPlanBox,
  type FloorPlanLayout,
  overlappingTables,
  TABLE_NAME_MAX_LENGTH,
} from '@durby/shared';
import { Redo2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useReducer, useState } from 'react';
import { Notice } from '../../../app/auth-layout';
import { useT } from '../../../app/labels-provider';
import { useAuth } from '../../../app/providers';
import { errorLabel } from '../../../lib/auth/errors';
import { loadTables } from '../../../lib/pos/api';
import {
  loadAreaPlan,
  loadPlanVersion,
  publishPlan,
  restorePlan,
  savePlan,
} from '../../../lib/pos/floor-plan-api';
import {
  editorReducer,
  EMPTY_LAYOUT,
  initialEditor,
  sameLayout,
  withExisting,
  withoutGone,
} from '../../../lib/pos/plan-editor';
import { useActionKey } from '../../../lib/use-action-key';
import { Field } from '../../form-dialog';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Select } from '../../ui/select';
import { ConfirmAction } from '../../users/common';
import { DesignerCanvas } from './designer-canvas';
import { GenerateDialog } from './generate-dialog';
import { HistoryPanel } from './history-panel';
import { PlanView, TableShapeBox } from './plan-canvas';

/** Room shapes to choose by hand; the generator makes any. */
const ROOMS = {
  wide2: { width: 1000, height: 500 },
  wide: { width: 1000, height: 600 },
  classic: { width: 1000, height: 750 },
  square: { width: 1000, height: 1000 },
  tall: { width: 600, height: 1000 },
} as const;
const ROOM_KEYS = Object.keys(ROOMS) as (keyof typeof ROOMS)[];

export interface PlanAccess {
  canManage: boolean;
  canCreate: boolean;
}

/** A plan to look at, with the names and looks its tables have now. */
export function PlanPicture({
  layout,
  tables,
}: {
  layout: FloorPlanLayout;
  tables: ReadonlyMap<string, DiningTable>;
}) {
  const t = useT();
  return (
    <PlanView
      layout={layout}
      label={t('pos.plan.canvas')}
      renderTable={(item) => {
        const table = item.tableId ? tables.get(item.tableId) : undefined;
        const look = table ?? item.create;
        return look ? (
          <TableShapeBox
            shape={look.shape}
            color={table?.color ?? 'neutral'}
            className={item.create ? 'border-dashed' : undefined}
          >
            <span className="text-sm font-semibold">{look.name}</span>
            <span className="text-xs text-muted-foreground">{look.seats}</span>
          </TableShapeBox>
        ) : null;
      }}
    />
  );
}

/** The floor plan designer of one area (docs/modules/pos.md → Step 8, ADR 0073). */
export function Designer({
  initialPlan,
  initialTables,
  access,
}: {
  initialPlan: AreaFloorPlanResponse;
  /** Every table in service at the location. */
  initialTables: DiningTable[];
  access: PlanAccess;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const saveKey = useActionKey();
  const publishKey = useActionKey();
  const restoreKey = useActionKey();
  const [plan, setPlan] = useState(initialPlan);
  const [allTables, setAllTables] = useState(initialTables);
  const [state, dispatch] = useReducer(editorReducer, null, () =>
    initialEditor(startLayout(initialPlan, initialTables)),
  );
  const [preview, setPreview] = useState<{ version: number; layout: FloorPlanLayout } | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const area = plan.area;
  const mine = allTables.filter((x) => x.areaId === area.id);
  const byId = new Map(mine.map((x) => [x.id, x]));
  const { layout } = state;
  const saved = plan.latest?.layout ?? EMPTY_LAYOUT;
  const dirty = !sameLayout(layout, saved);
  const latest = plan.latest?.version ?? 0;
  const unplaced = mine.filter((x) => !layout.tables.some((item) => item.tableId === x.id));
  const creates = layout.tables.flatMap((item) => (item.create ? [item.create.name] : []));
  const gone = plan.latest
    ? plan.latest.layout.tables.length -
      withoutGone(plan.latest.layout, new Set(byId.keys())).tables.length
    : 0;

  useLeaveWarning(dirty, t('pos.plan.leave'));
  useUndoKeys(dispatch);

  /** The newest plan and tables; `restart`: the editor starts over from them. */
  async function refresh(restart: boolean): Promise<void> {
    const [nextPlan, nextTables] = await Promise.all([
      loadAreaPlan(store, area.id),
      loadTables(store, area.locationId),
    ]);
    if (!nextPlan.ok || !nextTables.ok) {
      const failed = nextPlan.ok ? nextTables : nextPlan;
      setNotice({ text: failed.ok ? '' : t(errorLabel(failed.code)), tone: 'error' });
      return;
    }
    setPlan(nextPlan.data);
    setAllTables(nextTables.data);
    if (!restart) return;
    setConflict(false);
    setPreview(null);
    setNotice(null);
    dispatch({ type: 'load', layout: startLayout(nextPlan.data, nextTables.data) });
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    const result = await savePlan(store, saveKey, area.id, { baseVersion: latest, layout });
    if (result.ok && result.data) {
      // Right away, so that nothing looks unsaved while the history loads.
      setPlan((current) => ({ ...current, latest: result.data }));
      await refresh(false);
    } else if (!result.ok && result.code === 'pos.floor_plan_changed') {
      setConflict(true);
    } else if (!result.ok) {
      setNotice({ text: t(errorLabel(result.code)), tone: 'error' });
    }
    setBusy(false);
  }

  async function view(version: number) {
    const result = await loadPlanVersion(store, area.id, version);
    if (result.ok) setPreview(result.data);
    else setNotice({ text: t(errorLabel(result.code)), tone: 'error' });
  }

  const publishBlocked = dirty
    ? t('pos.plan.publishSaveFirst')
    : creates.length > 0 && !access.canCreate
      ? t('pos.plan.publishNoCreate')
      : null;
  const publishable = latest > 0 && (dirty || plan.live?.version !== latest);
  const nameOf = (key: string) => {
    const item = layout.tables.find((x) => x.key === key);
    return (item?.tableId ? byId.get(item.tableId)?.name : item?.create?.name) ?? '';
  };
  const overlaps = [...overlappingTables(layout)].map(nameOf);
  const room = ROOM_KEYS.find(
    (r) => ROOMS[r].width === layout.room.width && ROOMS[r].height === layout.room.height,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link href="/tables" className="text-sm text-muted-foreground hover:underline">
            {t('pos.plan.back')}
          </Link>
          <h1 className="text-2xl font-semibold">{t('pos.plan.title', { area: area.name })}</h1>
          <p className="text-sm text-muted-foreground" data-testid="plan-status">
            {plan.live
              ? t('pos.plan.liveVersion', { version: String(plan.live.version) })
              : t('pos.plan.notLive')}
            {' · '}
            {dirty
              ? t('pos.plan.unsaved')
              : latest > 0
                ? t('pos.plan.savedVersion', { version: String(latest) })
                : t('pos.plan.history.empty')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GenerateDialog
            existing={mine}
            takenNames={allTables.filter((x) => x.areaId !== area.id).map((x) => x.name)}
            onDraft={(draft) => {
              setPreview(null);
              dispatch({ type: 'replace', layout: draft });
            }}
          />
          <Button
            onClick={() => void save()}
            disabled={busy || !dirty || preview !== null}
            data-testid="plan-save"
          >
            {t('pos.plan.save')}
          </Button>
          {publishable && !publishBlocked ? (
            <ConfirmAction
              variant="default"
              testId="plan-publish"
              trigger={t('pos.plan.publish')}
              title={t('pos.plan.publishTitle', { version: String(latest) })}
              description={[
                t('pos.plan.publishText', { count: String(layout.tables.length) }),
                ...(creates.length > 0
                  ? [t('pos.plan.publishCreates', { names: creates.join(', ') })]
                  : []),
              ].join(' ')}
              confirm={t('pos.plan.publish')}
              run={() => publishPlan(store, publishKey, area.id, latest)}
              onDone={() =>
                void refresh(true).then(() =>
                  setNotice((n) => n ?? { text: t('pos.plan.published'), tone: 'info' }),
                )
              }
            />
          ) : (
            <Button disabled title={publishBlocked ?? undefined} data-testid="plan-publish">
              {t('pos.plan.publish')}
            </Button>
          )}
        </div>
      </div>

      {conflict ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="plan-conflict">
          <Notice text={t('pos.plan.changed')} tone="error" />
          <Button variant="outline" onClick={() => void refresh(true)}>
            {t('pos.plan.loadNewest')}
          </Button>
        </div>
      ) : null}
      <Notice text={notice?.text ?? null} tone={notice?.tone ?? 'info'} />
      {creates.length > 0 && !access.canCreate ? (
        <p className="text-sm text-muted-foreground">{t('pos.plan.publishNoCreate')}</p>
      ) : null}
      {gone > 0 && !preview ? (
        <p className="text-sm text-muted-foreground" data-testid="plan-gone">
          {t('pos.plan.gone', { count: String(gone) })}
        </p>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-3">
          {preview ? (
            <>
              <div className="flex flex-wrap items-center gap-3" data-testid="plan-preview">
                <span className="text-sm">
                  {t('pos.plan.history.viewing', { version: String(preview.version) })}
                </span>
                <Button variant="outline" onClick={() => setPreview(null)}>
                  {t('pos.plan.history.backToEditing')}
                </Button>
              </div>
              <PlanPicture layout={preview.layout} tables={byId} />
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2" data-testid="plan-tools">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t('pos.plan.undo')}
                  disabled={state.past.length === 0}
                  onClick={() => dispatch({ type: 'undo' })}
                >
                  <Undo2 aria-hidden />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t('pos.plan.redo')}
                  disabled={state.future.length === 0}
                  onClick={() => dispatch({ type: 'redo' })}
                >
                  <Redo2 aria-hidden />
                </Button>
                {FLOOR_PLAN_PIECES.map((kind) => (
                  <Button
                    key={kind}
                    variant="outline"
                    data-testid={`plan-add-${kind}`}
                    onClick={() => dispatch({ type: 'addPiece', kind })}
                  >
                    {t('pos.plan.addItem', { item: t(`pos.plan.pieces.${kind}`) })}
                  </Button>
                ))}
                <span className="flex items-center gap-2">
                  <Label htmlFor={`${id}-room`}>{t('pos.plan.room')}</Label>
                  <Select
                    id={`${id}-room`}
                    className="w-auto"
                    value={room ?? ''}
                    onChange={(e) => {
                      const next = ROOM_KEYS.find((r) => r === e.target.value);
                      if (next) dispatch({ type: 'room', room: { ...ROOMS[next] } });
                    }}
                  >
                    {room ? null : <option value="">{t('pos.plan.rooms.custom')}</option>}
                    {ROOM_KEYS.map((r) => (
                      <option key={r} value={r}>
                        {t(`pos.plan.rooms.${r}`)}
                      </option>
                    ))}
                  </Select>
                </span>
              </div>
              <DesignerCanvas state={state} dispatch={dispatch} tables={byId} />
              {overlaps.length > 0 ? (
                <p role="status" className="text-sm text-destructive" data-testid="plan-overlaps">
                  {t('pos.plan.overlaps', { names: overlaps.join(', ') })}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {layout.tables.length + layout.pieces.length === 0
                  ? t('pos.plan.empty')
                  : t('pos.plan.keys')}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-5">
          {preview ? null : (
            <>
              <Inspector
                key={state.selected ?? ''}
                state={state}
                dispatch={dispatch}
                name={selectedName(state, byId, t)}
              />
              <section className="flex flex-col gap-2" data-testid="plan-unplaced">
                <h2 className="text-sm font-medium">{t('pos.plan.notOnPlan')}</h2>
                {unplaced.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('pos.plan.allOnPlan')}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {unplaced.map((x) => (
                      <Button
                        key={x.id}
                        variant="outline"
                        aria-label={t('pos.plan.placeTable', { name: x.name })}
                        onClick={() =>
                          dispatch({ type: 'addTable', tableId: x.id, seats: x.seats })
                        }
                      >
                        {x.name}
                      </Button>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
          <HistoryPanel
            plan={plan}
            canManage
            onView={(version) => void view(version)}
            restore={(version) => restorePlan(store, restoreKey, area.id, version, latest)}
            onRestored={() => void refresh(true)}
          />
        </div>
      </div>
    </div>
  );
}

type T = ReturnType<typeof useT>;
type EditorProps = Parameters<typeof DesignerCanvas>[0];

/** What the editor starts with: the newest version without tables that are gone; new ones that exist by now are those. */
function startLayout(plan: AreaFloorPlanResponse, tables: readonly DiningTable[]): FloorPlanLayout {
  if (!plan.latest) return EMPTY_LAYOUT;
  const here = tables.filter((x) => x.areaId === plan.area.id);
  return withExisting(withoutGone(plan.latest.layout, new Set(here.map((x) => x.id))), here);
}

function selectedName(
  state: EditorProps['state'],
  tables: ReadonlyMap<string, DiningTable>,
  t: T,
): string | null {
  const { layout, selected } = state;
  const piece = layout.pieces.find((p) => p.key === selected);
  if (piece) return t(`pos.plan.pieces.${piece.kind}`);
  const item = layout.tables.find((x) => x.key === selected);
  return (item?.tableId ? tables.get(item.tableId)?.name : item?.create?.name) ?? null;
}

/** Exact values of the selected item; a new table's name and seats; delete. */
function Inspector({
  state,
  dispatch,
  name,
}: Pick<EditorProps, 'state' | 'dispatch'> & { name: string | null }) {
  const t = useT();
  const id = useId();
  const { layout, selected } = state;
  const table = layout.tables.find((x) => x.key === selected);
  const item = table ?? layout.pieces.find((p) => p.key === selected);
  if (!item || name === null) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">{t('pos.plan.selected')}</h2>
        <p className="text-sm text-muted-foreground">{t('pos.plan.nothingSelected')}</p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3" data-testid="plan-inspector">
      <h2 className="text-sm font-medium">
        {name}
        {table?.create ? ` · ${t('pos.plan.newTable')}` : null}
      </h2>
      {table?.create ? (
        <div className="grid grid-cols-2 gap-3">
          <Field id={`${id}-name`} label={t('pos.fields.name')} problem={null}>
            <DraftInput
              id={`${id}-name`}
              value={table.create.name}
              maxLength={TABLE_NAME_MAX_LENGTH}
              commit={(text) => {
                const next = text.trim();
                const taken = layout.tables.some(
                  (x) => x.key !== item.key && x.create?.name === next,
                );
                if (next === '' || taken) return false;
                dispatch({ type: 'rename', key: item.key, create: { name: next } });
                return true;
              }}
            />
          </Field>
          <Field id={`${id}-seats`} label={t('pos.fields.seats')} problem={null}>
            <DraftInput
              id={`${id}-seats`}
              value={String(table.create.seats)}
              commit={(text) => {
                const seats = /^\d{1,3}$/.test(text.trim()) ? Number(text) : 0;
                if (seats < 1 || seats > 100) return false;
                dispatch({ type: 'rename', key: item.key, create: { seats } });
                return true;
              }}
            />
          </Field>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        {(['x', 'y', 'width', 'height'] as const).map((side: keyof FloorPlanBox) => (
          <Field
            key={side}
            id={`${id}-${side}`}
            label={t(`pos.plan.fields.${side}`)}
            problem={null}
          >
            <DraftInput
              id={`${id}-${side}`}
              value={String(item[side])}
              commit={(text) => {
                if (!/^\d{1,4}$/.test(text.trim())) return false;
                dispatch({
                  type: 'place',
                  key: item.key,
                  box: { [side]: Number(text) },
                  exact: true,
                });
                return true;
              }}
            />
          </Field>
        ))}
      </div>
      <Button
        variant="outline"
        data-testid="plan-remove"
        onClick={() => dispatch({ type: 'remove', key: item.key })}
      >
        {t(table?.tableId ? 'pos.plan.takeOff' : 'pos.plan.removeItem')}
      </Button>
      {table?.tableId ? (
        <p className="text-xs text-muted-foreground">{t('pos.plan.takeOffHint')}</p>
      ) : null}
    </section>
  );
}

/** Follows the plan while it isn't typed in; takes the text on Enter or when left, and goes back if it's no good. */
function DraftInput({
  id,
  value,
  maxLength,
  commit,
}: {
  id: string;
  value: string;
  maxLength?: number;
  commit: (text: string) => boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = () => {
    if (draft !== null && draft !== value) commit(draft);
    setDraft(null);
  };
  return (
    <Input
      id={id}
      value={draft ?? value}
      maxLength={maxLength}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/** Asks before a link or the browser leaves with unsaved changes. */
function useLeaveWarning(dirty: boolean, text: string): void {
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      if (link.getAttribute('target') === '_blank') return;
      if (window.confirm(text)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('beforeunload', unload);
    // Before the app's own link handling.
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', click, true);
    };
  }, [dirty, text]);
}

/** Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z or Ctrl+Y, except while typing. */
function useUndoKeys(dispatch: EditorProps['dispatch']): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select'))
        return;
      const key = event.key.toLowerCase();
      const redo = key === 'y' || (key === 'z' && event.shiftKey);
      if (!redo && key !== 'z') return;
      event.preventDefault();
      dispatch({ type: redo ? 'redo' : 'undo' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dispatch]);
}
