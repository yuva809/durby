import { useEffect, useState } from 'react';
import { useAuth } from '../../app/providers';
import { loadPushConfig, type PushState, pushState, turnPushOff, turnPushOn } from './push';

/**
 * Push on this device for the active organization (ADR 0047): its state (null until known) and a switch, which must be
 * called from a tap because the browser asks for permission.
 */
export function usePushDevice(enabled = true): {
  state: PushState | null;
  busy: boolean;
  /** The last tap to turn it on didn't. */
  failed: boolean;
  toggle: () => Promise<void>;
} {
  const { store, session } = useAuth();
  const organizationId = enabled ? (session?.activeOrganizationId ?? null) : null;
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

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

  async function toggle() {
    const turnOn = state !== 'on';
    setBusy(true);
    let next: PushState;
    try {
      next = turnOn ? await turnPushOn(store, publicKey ?? '') : await turnPushOff(store);
    } catch {
      // The browser refused the subscription (e.g. a private window): leave it off.
      next = 'off';
    }
    setState(next);
    setFailed(turnOn && next === 'off');
    setBusy(false);
  }

  return { state, busy, failed, toggle };
}

/** An iPhone or iPad (iPadOS says it is a Mac): push needs the app on the home screen there. */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}
