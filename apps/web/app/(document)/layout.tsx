'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { ChoosePassword } from '../../components/auth/choose-password';
import { Skeleton } from '../../components/ui/skeleton';
import { loginPath } from '../../lib/auth/next-path';
import { useAuth } from '../providers';

/**
 * Printed on A4 with margins, the page shown: the app's own print rules are for 80 mm till receipts (globals.css: a
 * roll-sized page, everything but the receipt hidden). Only on these pages; later rules win.
 */
const DOCUMENT_PRINT_CSS = `@page { size: A4; margin: 14mm; }
@media print {
  html, body { width: auto; }
  body > :not(#print-root) { display: revert !important; }
}`;

/**
 * Printable documents of signed-in people (ADR 0064): the same guard as the app's pages, without the menu and the
 * bar, so a document fills the page and prints as it shows.
 */
export default function DocumentLayout({ children }: { children: ReactNode }) {
  const { status, session } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace(loginPath(pathname));
  }, [status, router, pathname]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-dvh flex-col gap-4 p-6" aria-busy="true">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-6 w-full max-w-md" />
      </div>
    );
  }
  if (session?.passwordChangeRequired) return <ChoosePassword />;
  return (
    <>
      <style>{DOCUMENT_PRINT_CSS}</style>
      <main className="min-h-dvh bg-muted/40 print:bg-transparent">{children}</main>
    </>
  );
}
