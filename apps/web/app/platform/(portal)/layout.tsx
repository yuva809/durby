'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { PortalShell } from '../../../components/staff/portal-shell';
import { useStaffSession } from '../../../components/staff/staff-session';
import { Skeleton } from '../../../components/ui/skeleton';

/** Signed-in staff pages: /platform/login when there is no active staff session. */
export default function PortalLayout({ children }: { children: ReactNode }) {
  const { session } = useStaffSession();
  const router = useRouter();

  useEffect(() => {
    if (session.status === 'signedOut') router.replace('/platform/login');
  }, [session.status, router]);

  if (session.status !== 'signedIn') {
    return (
      <div className="flex min-h-dvh flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-6 w-full max-w-md" />
      </div>
    );
  }
  return <PortalShell>{children}</PortalShell>;
}
