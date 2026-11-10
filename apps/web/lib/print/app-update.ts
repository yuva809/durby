import type { NativeInstallResult } from '@durby/shared';
import { useSyncExternalStore } from 'react';
import { nativePrinter } from './native';

/** How often the app is asked for a newer version while a page is open (plus once per page load). */
export const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * The in-app updater (ADR 0033 §14) as the page sees it. Never installs by itself: "Update now" asks the app, which
 * checks the download and hands it to Android's installer, which asks the user. "Later" hides the notice until the
 * next check.
 */
export interface AppUpdateState {
  available: { versionName: string } | null;
  dismissed: boolean;
  /** The last "Update now": null before, 'working' while the app downloads and checks. */
  install: NativeInstallResult | 'working' | 'no_answer' | null;
}

const INITIAL: AppUpdateState = { available: null, dismissed: false, install: null };
let state = INITIAL;
let started = false;
const listeners = new Set<() => void>();

function set(next: Partial<AppUpdateState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export async function checkForUpdate(): Promise<void> {
  const printer = nativePrinter();
  if (!printer || !(await printer.has('update'))) return;
  const available = await printer.checkUpdate();
  // A new check shows the notice again, even after "Later".
  set({ available: available ? { versionName: available.versionName } : null, dismissed: false });
}

/** Once per page: a check now, then every 6 hours. */
export function startUpdateChecks(): void {
  if (started) return;
  started = true;
  void checkForUpdate();
  setInterval(() => void checkForUpdate(), UPDATE_CHECK_EVERY_MS);
}

export function dismissUpdate(): void {
  set({ dismissed: true });
}

export async function installUpdate(): Promise<void> {
  const printer = nativePrinter();
  if (!printer || state.install === 'working') return;
  set({ install: 'working' });
  set({ install: (await printer.installUpdate()) ?? 'no_answer' });
}

export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => INITIAL,
  );
}

/** Tests: a fresh page. */
export function resetAppUpdate(): void {
  started = false;
  state = INITIAL;
}
