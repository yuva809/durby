import { useSyncExternalStore } from 'react';
import { useDeviceSettings } from './device-settings';

/**
 * The location this device prints jobs for (ADR 0033): the device setting (app 1.1, Settings → This device), else the
 * one its floor or order page shows last, held in memory: a till sits on its own location's floor, so that is where
 * its printers are. Null until either is known.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

export function setTillLocation(locationId: string | null): void {
  if (locationId === current) return;
  current = locationId;
  for (const listener of listeners) listener();
}

export function tillLocation(): string | null {
  return current;
}

export function useTillLocation(): string | null {
  const chosen = useDeviceSettings().settings.tillLocationId;
  const shown = useLastShownLocation();
  return chosen ?? shown;
}

function useLastShownLocation(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
