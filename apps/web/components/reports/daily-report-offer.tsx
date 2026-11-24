'use client';

import { useState } from 'react';
import { useT } from '../../app/labels-provider';
import { isAppleMobile, usePushDevice } from '../../lib/account/use-push-device';
import type { Session } from '../../lib/auth/session';
import { Button } from '../ui/button';
import { Card } from '../ui/card';

/** Who gets the daily sales report (ADR 0083): owners, with reports and the till. */
export function getsDailyReport(session: Session): boolean {
  return (
    session.activeRole?.systemKey === 'owner' &&
    session.activeFeatures.includes('reports') &&
    session.activeFeatures.includes('pos')
  );
}

/** On the overview: turn on push for the daily report here. Nothing once it is on, or where it can't work. */
export function DailyReportOffer({ session }: { session: Session }) {
  const t = useT();
  const { state, busy, failed, toggle } = usePushDevice(getsDailyReport(session));
  const [asked, setAsked] = useState(false);
  // Shown again as "on" right after the tap, so it says that it worked.
  const justOn = asked && state === 'on';
  const homeScreen = state === 'unsupported' && isAppleMobile();
  const blocked = asked && state === 'blocked';
  if (!(state === 'off' || justOn || homeScreen || blocked)) return null;
  return (
    <Card
      className="flex flex-wrap items-center justify-between gap-3 p-4"
      data-testid="daily-report-offer"
    >
      <p className="text-sm">
        {t('platform.notifications.dailySales.offer')}
        {state === 'off' && !failed ? null : (
          <span className="block text-muted-foreground">
            {failed
              ? t('platform.notifications.push.failed')
              : t(`platform.notifications.push.state.${state}`)}
          </span>
        )}
      </p>
      {state === 'off' ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setAsked(true);
            void toggle();
          }}
        >
          {t('platform.notifications.push.turnOn')}
        </Button>
      ) : null}
    </Card>
  );
}
