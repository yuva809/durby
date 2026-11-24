'use client';

import { useT } from '../../app/labels-provider';
import { usePushDevice } from '../../lib/account/use-push-device';
import { Button } from '../ui/button';
import { Card } from '../ui/card';

/**
 * Push on this device (ADR 0047): turn it on (the browser asks for permission) or off for the active organization.
 * Which updates are pushed is the "Push" column below; nothing is pushed until a device is on.
 */
export function PushDevice() {
  const t = useT();
  const { state, busy, failed, toggle } = usePushDevice();
  if (state === null) return null;

  const actionable = state === 'on' || state === 'off';
  return (
    <Card
      className="flex flex-wrap items-center justify-between gap-4 p-6"
      data-testid="push-device"
    >
      <div className="grid gap-1">
        <span className="font-medium">{t('platform.notifications.push.title')}</span>
        <span className="text-sm text-muted-foreground" data-testid="push-state">
          {failed
            ? t('platform.notifications.push.failed')
            : t(`platform.notifications.push.state.${state}`)}
        </span>
      </div>
      {actionable && (
        <Button
          variant={state === 'on' ? 'outline' : 'default'}
          onClick={() => void toggle()}
          disabled={busy}
          data-testid="push-toggle"
        >
          {t(
            state === 'on'
              ? 'platform.notifications.push.turnOff'
              : 'platform.notifications.push.turnOn',
          )}
        </Button>
      )}
    </Card>
  );
}
