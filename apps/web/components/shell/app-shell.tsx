'use client';

import { Menu } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../ui/sheet';
import { Wordmark } from '../wordmark';
import { AppUpdateNotice } from './app-update-notice';
import { OrgSwitcher } from './org-switcher';
import { SidebarNav } from './sidebar-nav';
import { UserMenu } from './user-menu';

/**
 * Signed-in layout (docs/platform/web-shell.md → Layout): a fixed sidebar from 1024 px, a drawer
 * below (back office on a tablet), a top bar with the organization switcher and the user menu.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-4 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('platform.shell.skipToContent')}
      </a>

      <aside className="hidden border-r bg-card lg:flex lg:flex-col">
        <div className="flex h-16 items-center px-6">
          <Wordmark />
        </div>
        <SidebarNav />
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
              <div className="flex h-16 items-center px-6">
                <Wordmark />
              </div>
              <SidebarNav onNavigate={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
          <Wordmark className="lg:hidden" />
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <OrgSwitcher />
            <UserMenu />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 outline-none sm:px-8">
          <AppUpdateNotice />
          {children}
        </main>
      </div>
    </div>
  );
}
