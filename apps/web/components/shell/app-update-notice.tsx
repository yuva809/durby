'use client';

import type { LabelKey } from '@durby/i18n';
import { useEffect } from 'react';
import { useT } from '../../app/labels-provider';
import {
  dismissUpdate,
  installUpdate,
  startUpdateChecks,
  useAppUpdate,
} from '../../lib/print/app-update';
import { nativePrinter } from '../../lib/print/native';
import { Button } from '../ui/button';

const RESULTS: Record<string, LabelKey> = {
  working: 'platform.shell.appUpdate.working',
  installing: 'platform.shell.appUpdate.installing',
  needs_permission: 'platform.shell.appUpdate.needsPermission',
};

/**
 * "A new version of the app is ready" (ADR 0033 §14), inside the Android app only. A small notice above the page,
 * never a dialog, so it never interrupts service on a till: nothing installs until someone taps "Update now", and
 * Android asks once more. "Later" hides it until the next check (every 6 hours and at each app start).
 */
export function AppUpdateNotice() {
  const t = useT();
  const update = useAppUpdate();
  useEffect(() => {
    if (nativePrinter()) startUpdateChecks();
  }, []);
  if (!update.available || update.dismissed) return null;
  const result = update.install;
  const message = result ? (RESULTS[result] ?? 'platform.shell.appUpdate.failed') : null;
  return (
    <div
      role="status"
      data-testid="app-update"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted px-4 py-3 text-sm"
    >
      <p className="flex-1">
        {t('platform.shell.appUpdate.available', { version: update.available.versionName })}
        {message && (
          <span className="block text-muted-foreground" data-testid="app-update-result">
            {t(message)}
          </span>
        )}
      </p>
      <Button
        variant="outline"
        disabled={result === 'working'}
        onClick={() => void installUpdate()}
        data-testid="app-update-install"
      >
        {t('platform.shell.appUpdate.install')}
      </Button>
      <Button variant="ghost" onClick={dismissUpdate} data-testid="app-update-later">
        {t('platform.shell.appUpdate.later')}
      </Button>
    </div>
  );
}
