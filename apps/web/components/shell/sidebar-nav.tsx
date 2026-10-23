'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { activeNavItem, NAV_GROUPS, NAV_ITEMS, visibleNav } from '../../lib/nav/registry';
import { cn } from '../../lib/utils';

/**
 * The navigation items the session may see (UI hints; the api enforces), grouped, with the
 * current page marked. `onNavigate` closes the drawer on tablets.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { session } = useAuth();
  const t = useT();
  const pathname = usePathname();
  const items = visibleNav(NAV_ITEMS, {
    activeFeatures: session?.activeFeatures ?? [],
    activePermissions: session?.activePermissions ?? [],
  });
  const current = activeNavItem(items, pathname);

  return (
    <nav aria-label={t('platform.nav.label')} className="flex flex-col gap-4 p-3">
      {NAV_GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.group === group.id);
        if (groupItems.length === 0) return null;
        const headingId = `nav-group-${group.id}`;
        return (
          <div key={group.id} role="group" aria-labelledby={group.label ? headingId : undefined}>
            {group.label && (
              <p
                id={headingId}
                className="px-3 pb-1 text-xs font-medium text-muted-foreground uppercase"
              >
                {t(group.label)}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {groupItems.map((item) => {
                const active = item.id === current?.id;
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      data-testid={`nav-${item.id}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={onNavigate}
                      className={cn(
                        'relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium text-foreground no-underline hover:bg-muted hover:no-underline',
                        active && 'bg-muted',
                      )}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute inset-y-2 left-0 w-1 rounded-full bg-primary"
                        />
                      )}
                      <Icon aria-hidden className="size-4 shrink-0" />
                      {t(item.label)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
