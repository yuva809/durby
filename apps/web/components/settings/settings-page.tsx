'use client';

import {
  DEFAULT_OPENING_HOURS,
  type ResolvedSetting,
  type SettingKey,
  type TurnTimes,
  type WeeklyHours,
} from '@durby/shared';
import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { Result } from '../../lib/api-call';
import { errorLabel } from '../../lib/auth/errors';
import type { ActionKey } from '../../lib/idempotency';
import { deleteSetting, loadSettings, putSetting } from '../../lib/settings/api';
import {
  codeDefaults,
  controlOf,
  isSetHere,
  isValidSettingValue,
  ORGANIZATION_SETTING_KEYS,
  type SettingControl,
  settingLabels,
} from '../../lib/settings/controls';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { DateListEditor, WeeklyHoursEditor } from './hours-editor';
import { LimitField, ScheduleOrField, TurnTimesEditor } from './reservation-editors';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';

/**
 * /settings/general (docs/platform/web-shell.md → Settings): the organization's settings, one
 * control per registry key. If `GET /settings` is denied or fails, the code defaults are shown
 * read-only instead (settings.md → Web app).
 */
export function SettingsPage() {
  const t = useT();
  const { store, session } = useAuth();
  const [resource] = useResource(session?.activeOrganizationId ?? null, () => loadSettings(store));
  // Saved rows replace their loaded value (the page doesn't reload the whole list after a save).
  const [saved, setSaved] = useState<Partial<Record<SettingKey, ResolvedSetting>>>({});
  const canManage = session?.activePermissions.includes('platform.settings.manage') ?? false;

  let body;
  if (resource.status === 'loading') {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  } else {
    const fallback = resource.status === 'error';
    const list = fallback ? codeDefaults() : resource.data;
    const byKey = new Map(list.map((s) => [s.key, s]));
    body = (
      <>
        {fallback && (
          <Notice
            text={t('platform.settingsPage.fallback', {
              reason: t(errorLabel(resource.code)),
            })}
            tone="info"
          />
        )}
        <ul className="flex flex-col gap-3">
          {ORGANIZATION_SETTING_KEYS.map((key) => {
            const setting = saved[key] ?? byKey.get(key);
            const control = controlOf(key);
            // Reservation hours narrow the opening hours: an own schedule starts from them.
            const openingHours = ((saved.openingHours ?? byKey.get('openingHours'))?.value ??
              DEFAULT_OPENING_HOURS) as WeeklyHours;
            if (!setting || !control) return null;
            if (control.kind === 'page') {
              return (
                <li key={key}>
                  <SettingLink settingKey={key} href={control.href} />
                </li>
              );
            }
            return (
              <li key={key}>
                <SettingRow
                  setting={setting}
                  control={control}
                  openingHours={openingHours}
                  writes={organizationWrites(store)}
                  editable={canManage && !fallback}
                  onSaved={(next) => setSaved((current) => ({ ...current, [key]: next }))}
                />
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('platform.nav.settings')}</h1>
      <p className="text-muted-foreground">{t('platform.settingsPage.description')}</p>
      {body}
    </div>
  );
}

/** A setting edited on a page of its own: its name, description and a link there. */
function SettingLink({ settingKey, href }: { settingKey: SettingKey; href: string }) {
  const t = useT();
  const labels = settingLabels(settingKey);
  return (
    <Card
      className="flex flex-wrap items-center justify-between gap-3 p-4"
      data-testid="setting"
      data-key={settingKey}
    >
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium">{t(labels.name)}</p>
        <p className="text-sm text-muted-foreground">{t(labels.description)}</p>
      </div>
      <Button asChild variant="outline" className="min-h-11">
        <Link href={href}>{t('platform.settingsPage.open')}</Link>
      </Button>
    </Card>
  );
}

/**
 * The value in the form's representation: text for text inputs, a number for number fields and
 * numeric selects ('' while empty), a boolean for checkboxes, the value itself for structured
 * settings (opening hours, closed days, turn times).
 */
type Draft = string | number | boolean | WeeklyHours | string[] | TurnTimes;

const draftOf = (value: unknown): Draft => {
  if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'object' && value !== null) return value as Draft;
  return JSON.stringify(value);
};

/** The text of a select or input draft. */
const textOf = (draft: Draft) =>
  typeof draft === 'string' || typeof draft === 'number' ? String(draft) : '';

/** Drafts are plain JSON values: equal when their JSON is. */
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** Where a SettingRow writes: the organization (settings api) or a location (a module's api). */
export interface SettingWrites {
  scope: 'organization' | 'location';
  put: (
    action: ActionKey,
    key: SettingKey,
    value: unknown,
  ) => Promise<Result<ResolvedSetting | null>>;
  remove: (action: ActionKey, key: SettingKey) => Promise<Result<unknown>>;
  /** The key's value after inheriting again (the api resolves it). */
  reload: (key: SettingKey) => Promise<ResolvedSetting | undefined>;
}

const organizationWrites = (store: Parameters<typeof loadSettings>[0]): SettingWrites => ({
  scope: 'organization',
  put: (action, key, value) => putSetting(store, action, key, value),
  remove: (action, key) => deleteSetting(store, action, key),
  reload: async (key) => {
    const reloaded = await loadSettings(store);
    return reloaded.ok ? reloaded.data.find((s) => s.key === key) : undefined;
  },
});

/**
 * One setting: its control, save and "use inherited". `below` renders under the control from the
 * current draft (e.g. why a schedule won't be fully offered).
 */
export function SettingRow({
  setting,
  control,
  openingHours,
  writes,
  editable,
  onSaved,
  below,
}: {
  setting: ResolvedSetting;
  control: SettingControl;
  openingHours: WeeklyHours;
  writes: SettingWrites;
  editable: boolean;
  onSaved: (setting: ResolvedSetting) => void;
  below?: (draft: unknown) => ReactNode;
}) {
  const t = useT();
  const id = useId();
  const saveAction = useActionKey();
  const inheritAction = useActionKey();
  const labels = settingLabels(setting.key);
  const [draft, setDraft] = useState<Draft>(draftOf(setting.value));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 409 settings.in_use: data already depends on the value; it can't change any more.
  const [locked, setLocked] = useState(false);

  const changed = !sameDraft(draftOf(setting.value), draft);
  const invalid = changed && !isValidSettingValue(setting.key, draft);
  const canEdit = editable && !locked;

  async function save() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    const result = await writes.put(saveAction, setting.key, draft);
    setBusy(false);
    if (result.ok && result.data) onSaved(result.data);
    else if (!result.ok) fail(result.code);
  }

  async function inherit() {
    setBusy(true);
    setError(null);
    const removed = await writes.remove(inheritAction, setting.key);
    if (!removed.ok) {
      setBusy(false);
      fail(removed.code);
      return;
    }
    // The inherited value is resolved by the api: read it back.
    const next = await writes.reload(setting.key);
    setBusy(false);
    if (next) {
      onSaved(next);
      setDraft(draftOf(next.value));
    }
  }

  function fail(code: Parameters<typeof errorLabel>[0]) {
    if (code === 'settings.in_use') setLocked(true);
    setError(t(errorLabel(code)));
  }

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="setting" data-key={setting.key}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-value`} className="text-base">
            {t(labels.name)}
          </Label>
          <p className="text-sm text-muted-foreground" id={`${id}-description`}>
            {t(labels.description)}
          </p>
        </div>
        <Badge data-testid="setting-source">
          {isSetHere(setting, writes.scope)
            ? t('platform.settingsPage.setHere')
            : t('platform.settingsPage.inherited')}
        </Badge>
      </div>

      {setting.dataBound && (
        <p className="flex items-start gap-2 text-sm" data-testid="setting-data-bound">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          {t('platform.settingsPage.dataBound')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {control.kind === 'boolean' ? (
          <div className="flex min-h-11 items-center gap-3">
            <Checkbox
              id={`${id}-value`}
              data-testid="setting-value"
              checked={draft === true}
              disabled={!canEdit}
              aria-describedby={`${id}-description`}
              onCheckedChange={(next) => setDraft(next === true)}
            />
            <span className="text-sm">
              {draft === true ? t('platform.settingsPage.on') : t('platform.settingsPage.off')}
            </span>
          </div>
        ) : control.kind === 'weeklyHours' ? (
          <WeeklyHoursEditor
            value={draft as WeeklyHours}
            disabled={!canEdit}
            describedBy={invalid ? `${id}-problem` : `${id}-description`}
            onChange={setDraft}
          />
        ) : control.kind === 'dateList' ? (
          <DateListEditor
            value={draft as string[]}
            disabled={!canEdit}
            describedBy={invalid ? `${id}-problem` : `${id}-description`}
            onChange={setDraft}
          />
        ) : control.kind === 'turnTimes' ? (
          <TurnTimesEditor
            value={draft as TurnTimes}
            disabled={!canEdit}
            describedBy={invalid ? `${id}-problem` : `${id}-description`}
            onChange={setDraft}
          />
        ) : control.kind === 'limit' ? (
          <LimitField
            value={draft}
            off={control.off}
            min={control.min}
            max={control.max}
            disabled={!canEdit}
            describedBy={invalid ? `${id}-problem` : `${id}-description`}
            onChange={(next) => setDraft(next as Draft)}
          />
        ) : control.kind === 'scheduleOr' ? (
          <ScheduleOrField
            value={draft}
            inherit={control.inherit}
            inherited={openingHours}
            disabled={!canEdit}
            describedBy={invalid ? `${id}-problem` : `${id}-description`}
            onChange={(next) => setDraft(next as Draft)}
          />
        ) : control.kind === 'number' ? (
          <Input
            id={`${id}-value`}
            type="number"
            min={control.min}
            max={control.max}
            step={1}
            data-testid="setting-value"
            className="w-28"
            value={textOf(draft)}
            disabled={!canEdit}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-problem` : `${id}-description`}
            onChange={(e) => setDraft(e.target.value.trim() === '' ? '' : Number(e.target.value))}
          />
        ) : control.kind === 'select' ? (
          <Select
            id={`${id}-value`}
            data-testid="setting-value"
            className="max-w-xs"
            value={textOf(draft)}
            disabled={!canEdit}
            aria-describedby={`${id}-description`}
            onChange={(e) => setDraft(control.numeric ? Number(e.target.value) : e.target.value)}
          >
            {control.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label ? t(option.label) : option.value}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id={`${id}-value`}
            data-testid="setting-value"
            className="max-w-xs"
            value={textOf(draft)}
            disabled={!canEdit}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-problem` : `${id}-description`}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
        {canEdit && (
          <>
            <Button
              data-testid="setting-save"
              disabled={!changed || invalid || busy}
              onClick={() => (setting.dataBound ? setConfirming(true) : void save())}
            >
              {t('platform.common.save')}
            </Button>
            {isSetHere(setting, writes.scope) && (
              <Button
                variant="outline"
                data-testid="setting-inherit"
                disabled={busy}
                onClick={() => void inherit()}
              >
                {t('platform.settingsPage.useInherited')}
              </Button>
            )}
          </>
        )}
      </div>

      {below?.(draft)}
      {invalid && (
        <p id={`${id}-problem`} role="alert" className="text-sm text-destructive">
          {t('platform.errors.settingsInvalidValue')}
        </p>
      )}
      <Notice text={error} tone="error" />

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>{t('platform.settingsPage.confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('platform.settingsPage.confirmDescription', { setting: t(labels.name) })}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('platform.common.cancel')}</AlertDialogCancel>
            <Button data-testid="setting-confirm" onClick={() => void save()}>
              {t('platform.settingsPage.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
