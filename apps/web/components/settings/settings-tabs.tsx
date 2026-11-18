'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { activeNavItem, type NavItem, visibleNav } from '../../lib/nav/registry';
import { SETTINGS_TABS } from '../../lib/nav/settings-tabs';
import { nativePrinter } from '../../lib/print/native';
import { cn } from '../../lib/utils';

/** The tabs the signed-in user may open (UI hints; every page and the api check again). */
function useSettingsTabs(): NavItem[] {
  const { session } = useAuth();
  if (!session) return [];
  const inApp = nativePrinter() !== null;
  return visibleNav(SETTINGS_TABS, {
    activeFeatures: session.activeFeatures,
    activePermissions: session.activePermissions,
  }).filter((tab) => inApp || !tab.appOnly);
}

/**
 * The tab bar above every settings page: Company, Locations, Members, Roles, … (one sidebar item,
 * docs/platform/web-shell.md → Settings). Scrolls sideways on narrow screens, with the open tab brought into view
 * (on a phone it was often off-screen) and a fade at the edge where more tabs are.
 */
export function SettingsTabs() {
  const t = useT();
  const pathname = usePathname();
  const tabs = useSettingsTabs();
  const current = activeNavItem(tabs, pathname);
  const activeLink = useRef<HTMLAnchorElement>(null);
  const currentId = current?.id;
  useEffect(() => {
    // inline: 'nearest' moves the strip only when the tab is (partly) hidden; block: 'nearest' never scrolls the page.
    activeLink.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [currentId]);
  if (tabs.length === 0) return null;
  return (
    <nav
      aria-label={t('platform.settingsTabs.label')}
      className="relative -mx-4 mb-6 border-b sm:-mx-8"
    >
      <ul className="flex scroll-px-4 gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:px-8 [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab) => {
          const active = tab.id === current?.id;
          return (
            <li key={tab.id} className="shrink-0">
              <Link
                ref={active ? activeLink : undefined}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                data-testid={`settings-tab-${tab.id}`}
                className={cn(
                  '-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap no-underline hover:no-underline',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(tab.label)}
              </Link>
            </li>
          );
        })}
      </ul>
      {/* More tabs to the right: a fade over the last few pixels (phones). */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-background to-transparent sm:hidden"
      />
    </nav>
  );
}

/** /settings: the first tab the user may open. */
export function SettingsIndex() {
  const tabs = useSettingsTabs();
  const router = useRouter();
  const first = tabs[0]?.href;
  useEffect(() => {
    if (first) router.replace(first);
  }, [first, router]);
  return null;
}
