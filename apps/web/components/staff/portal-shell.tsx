'use client';

import { type StaffPermissionKey, staffRoleLabel } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import {
  Building2,
  ClipboardList,
  House,
  LogOut,
  Menu,
  ShieldCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../ui/sheet';
import { useStaffSession } from './staff-session';

interface Item {
  href: string;
  label: LabelKey;
  icon: typeof House;
  permission: StaffPermissionKey;
}

const GROUPS: { label: LabelKey; items: Item[] }[] = [
  {
    label: 'staff.nav.groupOverview',
    items: [
      {
        href: '/platform',
        label: 'staff.nav.home',
        icon: House,
        permission: 'staff.portal.access',
      },
    ],
  },
  {
    label: 'staff.nav.groupCustomers',
    items: [
      {
        href: '/platform/customers',
        label: 'staff.nav.customers',
        icon: Building2,
        permission: 'staff.customers.read',
      },
      {
        href: '/platform/customers/new',
        label: 'staff.nav.onboard',
        icon: UserPlus,
        permission: 'staff.customers.create',
      },
    ],
  },
  {
    label: 'staff.nav.groupAdministration',
    items: [
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
    ],
  },
];

const ALL_HREFS = GROUPS.flatMap((g) => g.items.map((i) => i.href));

/** The item for `pathname`: the longest matching href (Onboard customer wins over Customers). */
export function activeHref(pathname: string): string | undefined {
  return ALL_HREFS.filter(
    (href) => pathname === href || (href !== '/platform' && pathname.startsWith(`${href}/`)),
  ).sort((a, b) => b.length - a.length)[0];
}

/**
 * The staff portal frame (docs/platform/admin-portal.md → Web): a fixed sidebar from 1024 px, a
 * drawer below, grouped pages the staff role may open (UI hints; the api checks every call), and
 * the signed-in staff member with sign-out at the bottom. Its own look, so staff always see which
 * side they are on.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const { session } = useStaffSession();
  const [menuOpen, setMenuOpen] = useState(false);
  if (session.status !== 'signedIn') return null;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="hidden border-r bg-card lg:flex lg:flex-col" data-testid="staff-sidebar">
        <Sidebar />
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 items-center gap-2 border-b bg-card px-2 lg:hidden">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t('staff.nav.openMenu')}>
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent closeLabel={t('platform.common.close')}>
              <SheetTitle className="sr-only">{t('staff.portal.title')}</SheetTitle>
              <SheetDescription className="sr-only">
                {t('staff.nav.menuDescription')}
              </SheetDescription>
              <div className="flex h-full flex-col">
                <Sidebar onNavigate={() => setMenuOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
          <PortalMark />
        </header>
        <main id="main" className="w-full max-w-6xl flex-1 px-4 py-6 sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function PortalMark() {
  return (
    <span className="flex items-center gap-2 font-semibold">
      <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <ShieldCheck aria-hidden className="size-4" />
      </span>
      {t('staff.portal.title')}
    </span>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { session, signOut } = useStaffSession();
  const pathname = usePathname();
  if (session.status !== 'signedIn') return null;
  const held = new Set<string>(session.me.permissions);
  const active = activeHref(pathname);

  return (
    <>
      <div className="flex h-16 items-center px-5">
        <PortalMark />
      </div>
      <nav aria-label={t('staff.portal.title')} className="flex flex-1 flex-col gap-5 p-3">
        {GROUPS.map((group) => {
          const items = group.items.filter((item) => held.has(item.permission));
          if (items.length === 0) return null;
          return (
            <div key={group.label}>
              <p className="px-3 pb-1 text-xs font-medium text-muted-foreground uppercase">
                {t(group.label)}
              </p>
              <ul className="flex flex-col gap-0.5">
                {items.map(({ href, label, icon: Icon }) => {
                  const current = href === active;
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        onClick={onNavigate}
                        aria-current={current ? 'page' : undefined}
                        data-testid="staff-nav-item"
                        className={cn(
                          'relative flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-foreground no-underline hover:bg-muted hover:no-underline',
                          current && 'bg-muted',
                        )}
                      >
                        {current && (
                          <span
                            aria-hidden
                            className="absolute inset-y-2 left-0 w-1 rounded-full bg-primary"
                          />
                        )}
                        <Icon aria-hidden className="size-4 shrink-0" />
                        {t(label)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="flex flex-col gap-2 border-t p-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" data-testid="staff-email">
            {session.me.email}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(staffRoleLabel(session.me.role) as LabelKey)}
          </p>
        </div>
        <Button
          variant="outline"
          className="justify-start"
          onClick={() => void signOut()}
          data-testid="staff-sign-out"
        >
          <LogOut aria-hidden />
          {t('staff.nav.signOut')}
        </Button>
      </div>
    </>
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
