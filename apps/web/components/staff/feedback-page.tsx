'use client';

import {
  FEEDBACK_STATUSES,
  type FeedbackStatus,
  type StaffFeedback,
  staffFeedbackListResponseSchema,
  staffFeedbackSchema,
} from '@durby/shared';
import { useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { errorLabel } from '../../lib/auth/errors';
import { t } from '../../lib/i18n';
import { staffCall } from '../../lib/staff/api';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { StaffNoAccess } from './portal-shell';
import { useStaffSession } from './staff-session';

const loadFeedback = (status: FeedbackStatus | null) =>
  staffCall(`/feedback${status ? `?status=${status}` : ''}`, {}, staffFeedbackListResponseSchema);
const setStatus = (id: string, status: FeedbackStatus) =>
  staffCall(`/feedback/${id}`, { method: 'PATCH', body: { status } }, staffFeedbackSchema);

/**
 * /platform/feedback (docs/platform/feedback.md, ADR 0044 step 5): what customers sent the platform team, newest first,
 * by status; `staff.feedback.manage` marks an item seen or done.
 */
export function StaffFeedbackPage() {
  const { session } = useStaffSession();
  const canRead =
    session.status === 'signedIn' && session.me.permissions.includes('staff.feedback.read');
  const [status, setFilter] = useState<FeedbackStatus | null>('new');
  const [items, reload] = useResource(canRead ? `feedback:${status ?? 'all'}` : null, () =>
    loadFeedback(status),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (session.status !== 'signedIn') return null;
  if (!canRead) return <StaffNoAccess />;
  const canManage = session.me.permissions.includes('staff.feedback.manage');

  async function mark(item: StaffFeedback, next: FeedbackStatus) {
    setBusy(item.id);
    setError(null);
    const result = await setStatus(item.id, next);
    setBusy(null);
    if (result.ok) reload();
    else setError(t(errorLabel(result.code)));
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('staff.nav.feedback')}</h1>
      <div
        role="tablist"
        aria-label={t('staff.feedbackPage.filter')}
        className="flex flex-wrap gap-2"
      >
        {[...FEEDBACK_STATUSES, null].map((s) => (
          <button
            key={s ?? 'all'}
            type="button"
            role="tab"
            aria-selected={s === status}
            onClick={() => setFilter(s)}
            className={cn(
              'min-h-11 rounded-md border px-4 text-sm font-medium hover:bg-muted',
              s === status && 'border-primary bg-muted ring-1 ring-primary',
            )}
            data-testid={`staff-feedback-filter-${s ?? 'all'}`}
          >
            {s ? t(`platform.feedback.statuses.${s}`) : t('staff.feedbackPage.all')}
          </button>
        ))}
      </div>
      <Notice text={error} tone="error" />
      {items.status === 'error' ? (
        <Notice text={t(errorLabel(items.code))} tone="error" />
      ) : items.status === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : items.data.data.length === 0 ? (
        <p className="text-muted-foreground">{t('staff.feedbackPage.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="staff-feedback">
          {items.data.data.map((item) => (
            <li key={item.id}>
              <Card className="flex flex-col gap-2 p-4" data-testid="staff-feedback-item">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge>{t(`platform.feedback.categories.${item.category}`)}</Badge>
                  <Badge>{t(`platform.feedback.statuses.${item.status}`)}</Badge>
                  <span className="font-medium">{item.organizationName}</span>
                  <span className="text-muted-foreground">
                    {[item.userEmail, item.pagePath, new Date(item.createdAt).toLocaleString()]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{item.message}</p>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    {FEEDBACK_STATUSES.filter((s) => s !== item.status).map((s) => (
                      <Button
                        key={s}
                        variant="outline"
                        disabled={busy === item.id}
                        onClick={() => void mark(item, s)}
                        data-testid={`staff-feedback-mark-${s}`}
                      >
                        {t(`staff.feedbackPage.mark.${s}`)}
                      </Button>
                    ))}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
