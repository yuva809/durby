'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { activeNavItem, type NavItem, visibleNav } from '../../lib/nav/registry';
import { SETTINGS_TABS } from '../../lib/nav/settings-tabs';
import { cn } from '../../lib/utils';

/** The tabs the signed-in user may open (UI hints; every page and the api check again). */
function useSettingsTabs(): NavItem[] {
  const { session } = useAuth();
  return session
    ? visibleNav(SETTINGS_TABS, {
        activeFeatures: session.activeFeatures,
        activePermissions: session.activePermissions,
      })
    : [];
}

/**
 * The tab bar above every settings page: Company, Locations, Members, Roles, … (one sidebar item,
 * docs/platform/web-shell.md → Settings). Scrolls sideways on narrow screens.
 */
export function SettingsTabs() {
  const t = useT();
  const pathname = usePathname();
  const tabs = useSettingsTabs();
  const current = activeNavItem(tabs, pathname);
  if (tabs.length === 0) return null;
  return (
    <nav aria-label={t('platform.settingsTabs.label')} className="-mx-4 mb-6 border-b sm:-mx-8">
      <ul className="flex gap-1 overflow-x-auto px-4 sm:px-8">
        {tabs.map((tab) => {
          const active = tab.id === current?.id;
          return (
            <li key={tab.id} className="shrink-0">
              <Link
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
