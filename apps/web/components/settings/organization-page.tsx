'use client';

import { ORGANIZATION_NAME_MAX_LENGTH } from '@durby/shared';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { renameOrganization } from '../../lib/settings/api';
import { useActionKey } from '../../lib/use-action-key';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

/** /settings/organization (docs/platform/web-shell.md → Organization profile). */
export function OrganizationPage() {
  const t = useT();
  const { store, session } = useAuth();
  const action = useActionKey();
  const id = useId();
  const current =
    session?.organizations.find((o) => o.id === session.activeOrganizationId)?.name ?? '';
  const canManage = session?.activePermissions.includes('platform.org.manage') ?? false;
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const blank = name.trim() === '';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (blank) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await renameOrganization(store, action, name.trim());
    if (result.ok) {
      // The switcher and the home page read the name from the session.
      await store.refresh();
      setSaved(true);
    } else {
      setError(t(errorLabel(result.code)));
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('platform.nav.organization')}</h1>
      <Card className="flex max-w-xl flex-col gap-4 p-6">
        {canManage ? (
          <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`}>{t('platform.organizationPage.name')}</Label>
              <Input
                id={`${id}-name`}
                data-testid="organization-name"
                value={name}
                maxLength={ORGANIZATION_NAME_MAX_LENGTH}
                aria-invalid={blank || undefined}
                aria-describedby={blank ? `${id}-problem` : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
              />
              {blank && (
                <p id={`${id}-problem`} role="alert" className="text-sm text-destructive">
                  {t('platform.organizationPage.nameRequired')}
                </p>
              )}
            </div>
            <Notice text={error} tone="error" />
            <Notice text={saved ? t('platform.organizationPage.saved') : null} tone="info" />
            <div>
              <Button type="submit" disabled={busy || blank} data-testid="organization-save">
                {t('platform.common.save')}
              </Button>
            </div>
          </form>
        ) : (
          <dl className="grid gap-1">
            <dt className="text-sm text-muted-foreground">{t('platform.organizationPage.name')}</dt>
            <dd className="font-medium">{current}</dd>
            <dd className="mt-2 text-sm text-muted-foreground">
              {t('platform.organizationPage.readOnly')}
            </dd>
          </dl>
        )}
      </Card>
    </div>
  );
}
