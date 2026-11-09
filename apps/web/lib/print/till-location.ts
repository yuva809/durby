import { useSyncExternalStore } from 'react';

/**
 * The location this device prints jobs for (ADR 0033): the one its floor or order page shows last, held in memory.
 * A till sits on its own location's floor, so that is where its printers are. Version 1.1 of the app makes it a
 * device setting. Null until such a page was open.
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
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
