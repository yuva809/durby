'use client';

import type { ResolvedSetting, SettingKey, WeeklyHours } from '@durby/shared';
import { TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
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
            if (!setting || !control) return null;
            return (
              <li key={key}>
                <SettingRow
                  setting={setting}
                  control={control}
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

/**
 * The value in the form's representation: text for selects and inputs, a boolean for checkboxes,
 * the value itself for structured settings (opening hours, closed days).
 */
type Draft = string | boolean | WeeklyHours | string[];

const draftOf = (value: unknown): Draft => {
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return value as Draft;
  return JSON.stringify(value);
};

/** The text of a select or input draft. */
const textOf = (draft: Draft) => (typeof draft === 'string' ? draft : '');

/** Drafts are plain JSON values: equal when their JSON is. */
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function SettingRow({
  setting,
  control,
  editable,
  onSaved,
}: {
  setting: ResolvedSetting;
  control: SettingControl;
  editable: boolean;
  onSaved: (setting: ResolvedSetting) => void;
}) {
  const t = useT();
  const { store } = useAuth();
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
    const result = await putSetting(store, saveAction, setting.key, draft);
    setBusy(false);
    if (result.ok && result.data) onSaved(result.data);
    else if (!result.ok) fail(result.code);
  }

  async function inherit() {
    setBusy(true);
    setError(null);
    const removed = await deleteSetting(store, inheritAction, setting.key);
    if (!removed.ok) {
      setBusy(false);
      fail(removed.code);
      return;
    }
    // The inherited value is resolved by the api: read it back.
    const reloaded = await loadSettings(store);
    setBusy(false);
    const next = reloaded.ok ? reloaded.data.find((s) => s.key === setting.key) : undefined;
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
          {isSetHere(setting)
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
        ) : control.kind === 'select' ? (
          <Select
            id={`${id}-value`}
            data-testid="setting-value"
            className="max-w-xs"
            value={textOf(draft)}
            disabled={!canEdit}
            aria-describedby={`${id}-description`}
            onChange={(e) => setDraft(e.target.value)}
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
            {isSetHere(setting) && (
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
