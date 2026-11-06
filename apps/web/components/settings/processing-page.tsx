'use client';

import type { LocationSummary, PrepStation, ResolvedSetting, SettingKey } from '@durby/shared';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { deleteSetting, loadSettings, putSetting } from '../../lib/settings/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';

const SWITCHES: readonly { station: PrepStation; key: SettingKey }[] = [
  { station: 'kitchen', key: 'pos.kitchenProcessing' },
  { station: 'bar', key: 'pos.barProcessing' },
];

/**
 * /settings/service (docs/modules/pos.md → Kitchen and bar processing, ADR 0031): whether the
 * kitchen and the bar prepare what waiters send (ticket and station screen), or items go straight
 * to the bill. For all locations or one location's own. Reading needs platform.settings.read,
 * changing platform.settings.manage (the api checks both).
 */
export function ProcessingPage() {
  const { store, session } = useAuth();
  const canRead = session?.activePermissions.includes('platform.settings.read') ?? false;
  const [locations, reload] = useResource(
    canRead ? (session?.activeOrganizationId ?? null) : null,
    () => loadLocations(store),
  );
  if (!session) return null;
  if (!canRead || !session.activeFeatures.includes('pos')) {
    return <NoAccess title="pos.processingSettings.title" />;
  }
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) => <ProcessingSettings locations={list} />}
    </Loaded>
  );
}

function ProcessingSettings({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const id = useId();
  const { store, session } = useAuth();
  // '' = all locations (organization scope).
  const [scope, setScope] = useState('');
  const [settings, reload] = useResource(`${session?.activeOrganizationId ?? ''}:${scope}`, () =>
    loadSettings(store, scope || undefined),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('pos.processingSettings.title')}</h1>
          <p className="max-w-2xl text-muted-foreground">
            {t('pos.processingSettings.description')}
          </p>
        </div>
        {locations.length > 0 && (
          <div className="grid min-w-56 gap-1.5">
            <Label htmlFor={`${id}-scope`}>{t('pos.billSettings.scope')}</Label>
            <Select
              id={`${id}-scope`}
              data-testid="processing-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">{t('pos.billSettings.wholeOrganization')}</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <Loaded resource={settings} reload={reload}>
        {(list) => (
          <ProcessingEditor
            key={scope}
            locationId={scope || null}
            settings={list}
            onChanged={reload}
          />
        )}
      </Loaded>
    </div>
  );
}

function ProcessingEditor({
  locationId,
  settings,
  onChanged,
}: {
  locationId: string | null;
  settings: ResolvedSetting[];
  onChanged: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store, session } = useAuth();
  const kitchenAction = useActionKey();
  const barAction = useActionKey();
  const resetKitchen = useActionKey();
  const resetBar = useActionKey();
  const canManage = session?.activePermissions.includes('platform.settings.manage') ?? false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = (key: SettingKey) => settings.find((s) => s.key === key);
  const ownHere =
    locationId !== null && SWITCHES.some(({ key }) => stored(key)?.source === 'location');

  async function toggle(station: PrepStation, key: SettingKey, on: boolean) {
    setBusy(true);
    setError(null);
    const action = station === 'kitchen' ? kitchenAction : barAction;
    const result = await putSetting(store, action, key, on, locationId ?? undefined);
    setBusy(false);
    if (result.ok) onChanged();
    else setError(t(errorLabel(result.code)));
  }

  async function inheritOrganization() {
    setBusy(true);
    setError(null);
    const scope = locationId ?? undefined;
    const results = [
      await deleteSetting(store, resetKitchen, 'pos.kitchenProcessing', scope),
      await deleteSetting(store, resetBar, 'pos.barProcessing', scope),
    ];
    setBusy(false);
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) setError(t(errorLabel(failed.code)));
    else onChanged();
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {error && <Notice text={error} tone="error" />}
      {locationId !== null && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm" data-testid="processing-scope-state">
            {t(
              ownHere
                ? 'pos.processingSettings.locationOverride'
                : 'pos.processingSettings.locationInherits',
            )}
          </p>
          {ownHere && canManage && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void inheritOrganization()}
              data-testid="processing-use-organization"
            >
              {t('pos.processingSettings.useOrganization')}
            </Button>
          )}
        </Card>
      )}
      <Card className="flex flex-col divide-y divide-border p-0">
        {SWITCHES.map(({ station, key }) => {
          const on = stored(key)?.value !== false;
          return (
            <div key={key} className="flex items-start gap-3 p-4">
              <Checkbox
                id={`${id}-${station}`}
                className="mt-0.5"
                checked={on}
                disabled={!canManage || busy}
                onCheckedChange={(checked) => void toggle(station, key, checked === true)}
                data-testid="processing-switch"
                data-station={station}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-${station}`} className="font-medium">
                  {t(`pos.processingSettings.${station}`)}
                </Label>
                <p className="text-sm text-muted-foreground" data-testid="processing-effect">
                  {t(
                    on
                      ? `pos.processingSettings.${station}On`
                      : `pos.processingSettings.${station}Off`,
                  )}
                </p>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
