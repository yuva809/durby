'use client';

import { ClipboardList, Menu } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../ui/sheet';
import { Wordmark } from '../wordmark';
import { AccountCard } from './account-card';
import { AppUpdateNotice } from './app-update-notice';
import { NotificationsBell } from './notifications-bell';
import { OrgSwitcher } from './org-switcher';
import { SearchBox } from './search-box';
import { SessionEnding } from './session-ending';
import { SidebarNav } from './sidebar-nav';

/**
 * Signed-in layout (docs/platform/web-shell.md → Layout, ADR 0046): a fixed sidebar from 1024 px, a drawer below
 * (back office on a tablet). The sidebar: the wordmark, "switch organization" when there are several, the menu, and the
 * person at the bottom. The top bar: search (Ctrl+K), the audit log for those who read it, the bell.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();
  const { session } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const canAudit = session?.activePermissions.includes('platform.audit.read') ?? false;

  const sidebar = (onNavigate?: () => void) => (
    <>
      <div className="flex h-16 shrink-0 items-center px-6">
        <Wordmark withName />
      </div>
      {(session?.organizations.length ?? 0) > 1 && (
        <div className="px-3 pb-2" data-testid="sidebar-switch">
          <OrgSwitcher />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav onNavigate={onNavigate} />
      </div>
      <AccountCard />
    </>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-4 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('platform.shell.skipToContent')}
      </a>

      <aside className="hidden border-r bg-card lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        {sidebar()}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex h-16 items-center gap-2 border-b bg-card px-2 sm:px-4">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label={t('platform.shell.openMenu')}
                data-testid="open-menu"
              >
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent closeLabel={t('platform.shell.closeMenu')}>
              <SheetTitle>{t('platform.shell.menuTitle')}</SheetTitle>
              <SheetDescription>{t('platform.shell.menuDescription')}</SheetDescription>
              {sidebar(() => setMenuOpen(false))}
            </SheetContent>
          </Sheet>
          <SearchBox />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {canAudit && (
              <Button variant="outline" asChild className="hidden sm:inline-flex">
                <Link href="/audit" data-testid="topbar-audit">
                  <ClipboardList aria-hidden />
                  {t('platform.nav.audit')}
                </Link>
              </Button>
            )}
            <NotificationsBell />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 outline-none sm:px-8">
          <SessionEnding />
          <AppUpdateNotice />
          {children}
        </main>
      </div>
    </div>
  );
}
