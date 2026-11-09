import { DEFAULT_DEVICE_SETTINGS, type NativeDeviceSettings } from '@durby/shared';
import { useSyncExternalStore } from 'react';
import { nativePrinter } from './native';

/**
 * This device's settings (ADR 0033 §5, §13): kept by the Android app from version 1.1 (`deviceSettings`), read once
 * per page. With app 1.0 or outside the app they live in memory for the page only (the web never uses browser
 * storage), which is the version 1 behaviour: the till asks for its receipt printer once per app start.
 */
export interface DeviceSettingsState {
  /** Read from the app (or known not to be there): until then nothing should act on `settings`. */
  loaded: boolean;
  /** The app keeps them across restarts. */
  stored: boolean;
  settings: NativeDeviceSettings;
}

const INITIAL: DeviceSettingsState = {
  loaded: false,
  stored: false,
  settings: DEFAULT_DEVICE_SETTINGS,
};

let state = INITIAL;
let loading: Promise<DeviceSettingsState> | null = null;
const listeners = new Set<() => void>();

function set(next: DeviceSettingsState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function deviceSettings(): DeviceSettingsState {
  return state;
}

/** Reads the settings from the app once per page; later calls share the answer. */
export function loadDeviceSettings(): Promise<DeviceSettingsState> {
  loading ??= (async () => {
    const printer = nativePrinter();
    let answer = null;
    try {
      answer =
        printer && (await printer.has('deviceSettings')) ? await printer.deviceSettings() : null;
    } catch {
      // An app that can't say: the version 1 behaviour, in memory.
    }
    set(
      answer
        ? { loaded: true, stored: true, settings: answer.settings }
        : { ...state, loaded: true, stored: false },
    );
    return state;
  })();
  return loading;
}

/**
 * Changes some settings: stored by the app when it can, else kept in memory. Answers false when the app refused or
 * didn't answer (the settings shown are what the app holds).
 */
export async function updateDeviceSettings(
  change: Partial<NativeDeviceSettings>,
): Promise<boolean> {
  await loadDeviceSettings();
  // The latest settings, not those of the first read: changes build on each other.
  const current = state;
  const wanted = { ...current.settings, ...change };
  if (!current.stored) {
    set({ ...state, settings: wanted });
    return true;
  }
  const answer = await nativePrinter()?.setDeviceSettings(wanted);
  if (!answer) return false;
  set({ ...state, settings: answer.settings });
  return !answer.refused;
}

export function useDeviceSettings(): DeviceSettingsState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => INITIAL,
  );
}

/** Tests: back to an unread page. */
export function resetDeviceSettings(): void {
  loading = null;
  set(INITIAL);
}
