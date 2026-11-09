'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loginPath } from '../../lib/auth/next-path';
import { Button } from '../ui/button';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The banner shows from this long before the sign-in ends (the 30-day cap, ADR 0006). */
export const SESSION_ENDING_WARN_MS = 3 * DAY_MS;

/** Whole days left, rounded up, while the end is near; null before that or without a known end. */
export function sessionDaysLeft(sessionExpiresAt: string | undefined, now: number): number | null {
  if (!sessionExpiresAt) return null;
  const left = Date.parse(sessionExpiresAt) - now;
  if (left > SESSION_ENDING_WARN_MS) return null;
  return Math.max(1, Math.ceil(left / DAY_MS));
}

/**
 * A sign-in ends after 30 days whatever happens. From 3 days before, this asks to sign in again at a quiet moment
 * (a till would otherwise sign out in the middle of service). Signing in again needs the password: a session is
 * never renewed silently past the cap.
 */
export function SessionEnding() {
  const t = useT();
  const { session, store } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const days = sessionDaysLeft(session?.sessionExpiresAt, now);
  if (days === null) return null;

  async function signInAgain() {
    await store.logout().catch(() => undefined);
    router.replace(loginPath(pathname));
  }

  return (
    <div
      role="status"
      data-testid="session-ending"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted px-4 py-3 text-sm"
    >
      <p className="flex-1">
        {days === 1
          ? t('platform.shell.sessionEnding.oneDay')
          : t('platform.shell.sessionEnding.days', { days: String(days) })}
      </p>
      <Button
        variant="outline"
        onClick={() => void signInAgain()}
        data-testid="session-sign-in-again"
      >
        {t('platform.shell.sessionEnding.signInAgain')}
      </Button>
    </div>
  );
}
