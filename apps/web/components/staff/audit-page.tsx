'use client';

import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_SYSTEM_ACTORS,
  type PlatformAuditEntry,
  type PlatformAuditSystemActor,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { errorLabel } from '../../lib/auth/errors';
import { t } from '../../lib/i18n';
import { staffApi } from '../../lib/staff/api';
import { useResource } from '../../lib/use-resource';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { StaffNoAccess } from './portal-shell';
import { useStaffSession } from './staff-session';

function actorName(entry: PlatformAuditEntry): string {
  if (entry.actor.type === 'system') {
    const label = PLATFORM_AUDIT_SYSTEM_ACTORS[entry.actor.name as PlatformAuditSystemActor]?.label;
    return label ? t(label) : (entry.actor.name ?? '');
  }
  return entry.actor.name ?? t('staff.auditPage.unknownActor');
}

/** A snapshot change in one line: `role: support → super_admin`. Fields are allow-listed by the api. */
function changes(entry: PlatformAuditEntry): string {
  const keys = [
    ...new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})]),
  ];
  return keys
    .filter((key) => key !== 'id' && entry.before?.[key] !== entry.after?.[key])
    .map((key) => {
      // Snapshot values are flat (ids, enums, strings): JSON shows them plainly.
      const show = (value: unknown) =>
        value === undefined || value === null
          ? '–'
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
      return entry.before
        ? `${key}: ${show(entry.before[key])} → ${show(entry.after?.[key])}`
        : `${key}: ${show(entry.after?.[key])}`;
    })
    .join(', ');
}

/** /platform/audit: every staff action, newest first, 50 at a time (staff.audit.read). */
export function PlatformAuditPage() {
  const { session } = useStaffSession();
  const canRead =
    session.status === 'signedIn' && session.me.permissions.includes('staff.audit.read');
  const [first] = useResource(canRead ? 'audit' : null, () => staffApi.audit());
  const [more, setMore] = useState<{ entries: PlatformAuditEntry[]; cursor: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session.status !== 'signedIn') return null;
  if (!session.me.permissions.includes('staff.audit.read')) return <StaffNoAccess />;

  const entries = [...(first.status === 'ready' ? first.data.data : []), ...(more?.entries ?? [])];
  const cursor = more ? more.cursor : first.status === 'ready' ? first.data.nextCursor : null;

  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    const result = await staffApi.audit(cursor);
    setBusy(false);
    if (!result.ok) {
      setError(t(errorLabel(result.code)));
      return;
    }
    setMore((prev) => ({
      entries: [...(prev?.entries ?? []), ...result.data.data],
      cursor: result.data.nextCursor,
    }));
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('staff.nav.audit')}</h1>
      {first.status === 'error' ? (
        <Notice text={t(errorLabel(first.code))} tone="error" />
      ) : first.status === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground">{t('staff.auditPage.empty')}</p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="platform-audit">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">{t('staff.auditPage.time')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.auditPage.actor')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.auditPage.action')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.auditPage.entity')}</th>
                <th className="px-4 py-3 font-medium">{t('staff.auditPage.reason')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.map((entry) => (
                <tr key={entry.id} data-testid="platform-audit-row">
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">{actorName(entry)}</td>
                  <td className="px-4 py-3 font-medium">
                    {t(PLATFORM_AUDIT_ACTIONS[entry.action].label as LabelKey)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{changes(entry)}</td>
                  <td className="px-4 py-3">{entry.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <Notice text={error} tone="error" />
      {cursor && (
        <div>
          <Button variant="outline" disabled={busy} onClick={() => void loadMore()}>
            {t('staff.auditPage.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
