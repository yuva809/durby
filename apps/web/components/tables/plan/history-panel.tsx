'use client';

import type { AreaFloorPlanResponse } from '@durby/shared';
import { useT } from '../../../app/labels-provider';
import { useAuth } from '../../../app/providers';
import type { Result } from '../../../lib/api-call';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmAction } from '../../users/common';

/** The saved versions, newest first: look at one, or restore it as the newest (ADR 0073). */
export function HistoryPanel({
  plan,
  canManage,
  onView,
  restore,
  onRestored,
}: {
  plan: AreaFloorPlanResponse;
  canManage: boolean;
  onView: (version: number) => void;
  restore: (version: number) => Promise<Result<unknown>>;
  onRestored: () => void;
}) {
  const t = useT();
  const { session } = useAuth();
  const time = new Intl.DateTimeFormat(session?.user.locale, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return (
    <section className="flex flex-col gap-2" data-testid="plan-history">
      <h2 className="text-sm font-medium">{t('pos.plan.history.title')}</h2>
      {plan.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pos.plan.history.empty')}</p>
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          {plan.history.map((v) => {
            const at = time.format(new Date(v.createdAt));
            return (
              <li
                key={v.version}
                data-testid="plan-version"
                data-version={v.version}
                className="flex flex-col gap-1 rounded-md border border-border p-2 text-sm"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {t('pos.plan.history.item', { version: String(v.version) })}
                  </span>
                  {plan.live?.version === v.version ? (
                    <Badge>{t('pos.plan.history.live')}</Badge>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {v.createdBy ? t('pos.plan.history.by', { time: at, name: v.createdBy }) : at}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('pos.plan.history.counts', {
                    tables: String(v.tables),
                    pieces: String(v.pieces),
                  })}
                </span>
                {v.restoredFrom === null ? null : (
                  <span className="text-xs text-muted-foreground">
                    {t('pos.plan.history.restoredFrom', { version: String(v.restoredFrom) })}
                  </span>
                )}
                <span className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => onView(v.version)}>
                    {t('pos.plan.history.view')}
                  </Button>
                  {canManage && v.version !== plan.latest?.version ? (
                    <ConfirmAction
                      variant="default"
                      trigger={t('pos.plan.history.restore')}
                      testId="plan-restore"
                      title={t('pos.plan.history.restoreTitle', { version: String(v.version) })}
                      description={t('pos.plan.history.restoreText')}
                      confirm={t('pos.plan.history.restore')}
                      run={() => restore(v.version)}
                      onDone={onRestored}
                    />
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
