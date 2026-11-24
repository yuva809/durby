'use client';

import type { LabelKey } from '@durby/i18n';
import type { NotificationKind, NotificationPreference } from '@durby/shared';
import Link from 'next/link';
import { useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  loadNotificationPreferences,
  saveNotificationPreferences,
} from '../../lib/account/notifications-api';
import { errorLabel } from '../../lib/auth/errors';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { camel } from '../../lib/workspace/api';
import { getsDailyReport } from '../reports/daily-report-offer';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { PushDevice } from './push-device';

type Channel = 'email' | 'push';

/**
 * /account/notifications (ADR 0047): per kind of update, whether it also comes by email (and, on a device where push
 * is on, as a push message). The bell always has every update. Choices are per organization.
 */
export function NotificationSettings() {
  const t = useT();
  const { store, session } = useAuth();
  const action = useActionKey();
  const organizationId = session?.activeOrganizationId ?? null;
  const [loaded, reload] = useResource(organizationId, () => loadNotificationPreferences(store));
  const [edits, setEdits] = useState<Partial<Record<NotificationKind, NotificationPreference>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  if (!session) return null;

  // Only owners get the daily report, so nobody else chooses for it (ADR 0083).
  const daily = getsDailyReport(session);
  const rows =
    loaded.status === 'ready'
      ? loaded.data.filter((p) => daily || p.kind !== 'daily_sales').map((p) => edits[p.kind] ?? p)
      : ([] as const);
  const changed = Object.keys(edits).length > 0;

  const toggle = (row: NotificationPreference, channel: Channel, value: boolean) =>
    setEdits((current) => ({ ...current, [row.kind]: { ...row, [channel]: value } }));

  async function save() {
    setBusy(true);
    setNotice(null);
    const result = await saveNotificationPreferences(store, action, {
      preferences: Object.values(edits),
    });
    if (result.ok) {
      setEdits({});
      reload();
      setNotice({ text: t('platform.account.saved'), tone: 'info' });
    } else {
      setNotice({ text: t(errorLabel(result.code)), tone: 'error' });
    }
    setBusy(false);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href="/account" className="text-sm text-muted-foreground hover:underline">
          {t('platform.account.title')}
        </Link>
        <h1 className="text-2xl font-semibold">{t('platform.notifications.settings.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('platform.notifications.settings.intro')}
        </p>
      </div>
      <PushDevice />
      <Card className="p-0">
        {loaded.status === 'error' ? (
          <p className="p-6 text-sm text-destructive">{t(errorLabel(loaded.code))}</p>
        ) : (
          <table className="w-full text-sm" data-testid="notification-settings">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3 font-medium">{t('platform.notifications.settings.kind')}</th>
                <th className="w-20 p-3 text-center font-medium">
                  {t('platform.notifications.settings.email')}
                </th>
                <th className="w-20 p-3 text-center font-medium">
                  {t('platform.notifications.settings.push')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const name = t(`platform.notifications.kindNames.${camel(row.kind)}` as LabelKey);
                return (
                  <tr key={row.kind} className="border-b last:border-0" data-testid="pref-row">
                    <td className="p-3">{name}</td>
                    {(['email', 'push'] as const).map((channel) => (
                      <td key={channel} className="p-3 text-center">
                        <Checkbox
                          checked={row[channel]}
                          onCheckedChange={(value) => toggle(row, channel, value === true)}
                          aria-label={`${name}: ${t(`platform.notifications.settings.${channel}`)}`}
                          data-testid={`pref-${row.kind}-${channel}`}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      {daily ? (
        <p className="text-sm text-muted-foreground" data-testid="daily-report-note">
          {t('platform.notifications.dailySales.lockScreen')}
        </p>
      ) : null}
      <Notice text={notice?.text ?? null} tone={notice?.tone ?? 'info'} />
      <div>
        <Button
          onClick={() => void save()}
          disabled={busy || !changed}
          data-testid="notification-settings-save"
        >
          {t('platform.common.save')}
        </Button>
      </div>
    </div>
  );
}
