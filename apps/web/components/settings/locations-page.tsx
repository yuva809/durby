'use client';

import type { LabelKey } from '@durby/i18n';
import { LOCATION_NAME_MAX_LENGTH, type LocationSummary } from '@durby/shared';
import { MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createLocation, deleteLocation, renameLocation } from '../../lib/settings/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { Field, FormDialog } from '../form-dialog';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';

/**
 * /settings/locations (docs/platform/web-shell.md → Locations). Everyone with
 * platform.settings.read sees the list; only owners (platform.org.manage) add, rename and delete.
 * Also /branches in the operations menu (ADR 0044), with its own title.
 */
export function LocationsPage({ title = 'platform.nav.locations' }: { title?: LabelKey } = {}) {
  const t = useT();
  const { store, session } = useAuth();
  const [locations, reload] = useResource(session?.activeOrganizationId ?? null, () =>
    loadLocations(store),
  );
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('platform.settings.read')) return <NoAccess title={title} />;
  const canManage = permissions.has('platform.org.manage');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t(title)}</h1>
          <p className="text-muted-foreground">{t('platform.locationsPage.intro')}</p>
        </div>
        {canManage && <LocationDialog onDone={reload} />}
      </div>
      <Loaded resource={locations} reload={reload}>
        {(list) => {
          const visible = title === 'platform.nav.branches'
            ? list.filter((location) => !location.isWarehouseSite)
            : list;
          return visible.length === 0 ? (
            <Card
              className="flex flex-col items-center gap-2 px-6 py-12 text-center"
              data-testid="locations-empty"
            >
              <MapPin aria-hidden className="size-8 text-muted-foreground" />
              <p className="max-w-sm text-muted-foreground">{t('platform.locationsPage.empty')}</p>
            </Card>
          ) : (
            <Card className="max-w-2xl p-0">
              <ul className="divide-y divide-border" data-testid="location-list">
                {visible.map((location) => (
                  <li
                    key={location.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                    data-testid="location-row"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <MapPin aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{location.name}</span>
                    </span>
                    {canManage && (
                      <span className="flex shrink-0 gap-2">
                        <LocationDialog location={location} onDone={reload} />
                        <DeleteLocation location={location} onDone={reload} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          );
        }}
      </Loaded>
      {!canManage && (
        <p className="text-sm text-muted-foreground">{t('platform.locationsPage.readOnly')}</p>
      )}
    </div>
  );
}

/** Add (no `location`) or rename a location. */
function LocationDialog({ location, onDone }: { location?: LocationSummary; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [name, setName] = useState('');
  const [checked, setChecked] = useState(false);
  const problem = checked && name.trim() === '' ? t('platform.locationsPage.nameRequired') : null;
  return (
    <FormDialog
      trigger={
        location
          ? t('platform.locationsPage.rename', { name: location.name })
          : t('platform.locationsPage.add')
      }
      triggerVariant={location ? 'outline' : 'default'}
      triggerIcon={location ? <Pencil aria-hidden /> : undefined}
      testId={location ? 'location-rename' : 'location-create'}
      title={t(location ? 'platform.locationsPage.renameTitle' : 'platform.locationsPage.addTitle')}
      onOpen={() => {
        setName(location?.name ?? '');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        const trimmed = name.trim();
        if (trimmed === '') return null;
        return location
          ? renameLocation(store, action, location.id, trimmed)
          : createLocation(store, action, trimmed);
      }}
      onDone={onDone}
    >
      <Field id={`${id}-name`} label={t('platform.locationsPage.name')} problem={problem}>
        <Input
          id={`${id}-name`}
          data-testid="location-name"
          value={name}
          maxLength={LOCATION_NAME_MAX_LENGTH}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-name-problem` : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

/** The api refuses a location still in use (locations.in_use); the dialog then shows why. */
function DeleteLocation({ location, onDone }: { location: LocationSummary; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  return (
    <ConfirmAction
      testId="location-delete"
      trigger={t('platform.locationsPage.delete', { name: location.name })}
      triggerIcon={<Trash2 aria-hidden />}
      title={t('platform.locationsPage.deleteTitle', { name: location.name })}
      description={t('platform.locationsPage.deleteDescription')}
      confirm={t('platform.locationsPage.deleteConfirm')}
      run={() => deleteLocation(store, action, location.id)}
      onDone={onDone}
    />
  );
}

/**
 * "You have no locations." on pages that need one (Tables, Service), with a link here for owners,
 * the only ones who can add one.
 */
export function NoLocations({ message }: { message: string }) {
  const t = useT();
  const { session } = useAuth();
  const canManage = session?.activePermissions.includes('platform.org.manage') ?? false;
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-muted-foreground">{message}</p>
      {canManage && (
        <Button asChild data-testid="add-first-location">
          <Link href="/settings/locations">
            <Plus aria-hidden />
            {t('platform.locationsPage.addFirst')}
          </Link>
        </Button>
      )}
    </div>
  );
}
