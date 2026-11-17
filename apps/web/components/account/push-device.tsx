'use client';

import { useEffect, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  loadPushConfig,
  type PushState,
  pushState,
  turnPushOff,
  turnPushOn,
} from '../../lib/account/push';
import { Button } from '../ui/button';
import { Card } from '../ui/card';

/**
 * Push on this device (ADR 0047): turn it on (the browser asks for permission) or off for the active organization.
 * Which updates are pushed is the "Push" column below; nothing is pushed until a device is on.
 */
export function PushDevice() {
  const t = useT();
  const { store, session } = useAuth();
  const organizationId = session?.activeOrganizationId ?? null;
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (organizationId === null) return;
    let current = true;
    void (async () => {
      const config = await loadPushConfig(store);
      const key = config.ok ? config.data.publicKey : null;
      const next = await pushState(store, key);
      if (!current) return;
      setPublicKey(key);
      setState(next);
    })();
    return () => {
      current = false;
    };
  }, [organizationId, store]);

  if (state === null) return null;

  async function toggle() {
    setBusy(true);
    try {
      setState(
        state === 'on' ? await turnPushOff(store) : await turnPushOn(store, publicKey ?? ''),
      );
    } catch {
      // The browser refused the subscription (e.g. a private window): leave it off.
      setState('off');
    }
    setBusy(false);
  }

  const actionable = state === 'on' || state === 'off';
  return (
    <Card
      className="flex flex-wrap items-center justify-between gap-4 p-6"
      data-testid="push-device"
    >
      <div className="grid gap-1">
        <span className="font-medium">{t('platform.notifications.push.title')}</span>
        <span className="text-sm text-muted-foreground" data-testid="push-state">
          {t(`platform.notifications.push.state.${state}`)}
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
