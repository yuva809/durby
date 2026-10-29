'use client';

import type { StaffPermissionKey } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { ClipboardList, House, LogOut, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { useStaffSession } from './staff-session';

const ITEMS: {
  href: string;
  label: LabelKey;
  icon: typeof House;
  permission: StaffPermissionKey;
}[] = [
  { href: '/platform', label: 'staff.nav.home', icon: House, permission: 'staff.portal.access' },
  {
    href: '/platform/staff',
    label: 'staff.nav.staff',
    icon: Users,
    permission: 'staff.staff.read',
  },
  {
    href: '/platform/audit',
    label: 'staff.nav.audit',
    icon: ClipboardList,
    permission: 'staff.audit.read',
  },
];

/**
 * The staff portal frame: a top bar with the portal mark, the pages the staff role may open (UI
 * hints; the api checks every call) and sign-out. Deliberately unlike the customer shell, so staff
 * always see which side they are on.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const { session, signOut } = useStaffSession();
  const pathname = usePathname();
  if (session.status !== 'signedIn') return null;
  const held = new Set<string>(session.me.permissions);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2 font-semibold">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <ShieldCheck aria-hidden className="size-4" />
            </span>
            {t('staff.portal.title')}
          </span>
          <nav
            aria-label={t('staff.portal.title')}
            className="order-last w-full sm:order-none sm:w-auto"
          >
            <ul className="flex gap-1 overflow-x-auto">
              {ITEMS.filter((item) => held.has(item.permission)).map(
                ({ href, label, icon: Icon }) => {
                  const active =
                    href === '/platform' ? pathname === href : pathname.startsWith(href);
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap text-foreground no-underline hover:bg-muted hover:no-underline',
                          active && 'bg-muted',
                        )}
                      >
                        <Icon aria-hidden className="size-4" />
                        {t(label)}
                      </Link>
                    </li>
                  );
                },
              )}
            </ul>
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span
              className="hidden truncate text-sm text-muted-foreground md:inline"
              data-testid="staff-email"
            >
              {session.me.email}
            </span>
            <Button variant="ghost" onClick={() => void signOut()} data-testid="staff-sign-out">
              <LogOut aria-hidden />
              {t('staff.nav.signOut')}
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}

/** A page the staff role doesn't include (the api would refuse it anyway). */
export function StaffNoAccess() {
  return (
    <p className="text-muted-foreground" data-testid="staff-no-access">
      {t('staff.portal.noAccess')}
    </p>
  );
}
