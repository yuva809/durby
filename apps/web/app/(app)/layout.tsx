'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { ChoosePassword } from '../../components/auth/choose-password';
import { AppShell } from '../../components/shell/app-shell';
import { Skeleton } from '../../components/ui/skeleton';
import { loginPath } from '../../lib/auth/next-path';
import { useAuth } from '../providers';

/**
 * Signed-in pages. The access token lives in memory only (docs/platform/auth.md → Web), so the
 * guard runs in the browser: a skeleton while the session restores, /login when there is none.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { status, session } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace(loginPath(pathname));
  }, [status, router, pathname]);

  if (status !== 'authenticated') {
    return (
      <div
        className="flex min-h-dvh flex-col gap-4 p-6"
        aria-busy="true"
        data-testid="shell-loading"
      >
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-6 w-full max-w-md" />
        <Skeleton className="h-6 w-full max-w-sm" />
      </div>
    );
  }
  // A temporary password: nothing else until it is changed (ADR 0023 §3).
  if (session?.passwordChangeRequired) return <ChoosePassword />;
  return <AppShell>{children}</AppShell>;
}
