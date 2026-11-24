'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadSettings } from '../../lib/settings/api';
import { useResource } from '../../lib/use-resource';
import { useNavLayout } from '../theme-provider';
import { navLayout } from '../../lib/nav/layouts';
import { activeNavItem, type NavAccess, type NavItem, visibleNav } from '../../lib/nav/registry';
import { cn } from '../../lib/utils';

const ITEM_CLASS =
  'relative flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-foreground no-underline hover:bg-muted hover:no-underline';

/**
 * The navigation items the session may see (UI hints; the api enforces), grouped, with the
 * current page marked, in the layout of the partner's theme (ADR 0044). `onNavigate` closes the drawer
 * on tablets.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { session, store } = useAuth();
  const t = useT();
  const pathname = usePathname();
  // The organization's switches (settings, e.g. orders.showSalesOrders): a menu item may be hidden by one that is off.
  const [settings] = useResource(session?.activeOrganizationId ?? null, () => loadSettings(store));
  const access: NavAccess = {
    activeFeatures: session?.activeFeatures ?? [],
    activePermissions: session?.activePermissions ?? [],
    offSettings:
      settings.status === 'ready'
        ? settings.data.filter((s) => s.value === false).map((s) => s.key)
        : [],
    hideHome:
      settings.status === 'ready' &&
      settings.data.some((s) => s.key === 'startPage' && s.value === 'inventory'),
  };
  const layout = navLayout(useNavLayout(), access);
  const items = visibleNav(layout.items, access);
  const current = activeNavItem(items, pathname);

  return (
    <nav aria-label={t('platform.nav.label')} className="flex flex-col gap-4 p-3">
      {layout.groups.map((group) => {
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
              {groupItems.map((item) =>
                item.submenu && item.children ? (
                  <Submenu
                    key={item.id}
                    item={item}
                    pages={visibleNav(item.children, access)}
                    pathname={pathname}
                    onNavigate={onNavigate}
                  />
                ) : (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      data-testid={`nav-${item.id}`}
                      aria-current={item.id === current?.id ? 'page' : undefined}
                      onClick={onNavigate}
                      className={cn(ITEM_CLASS, item.id === current?.id && 'bg-muted')}
                    >
                      {item.id === current?.id && <ActiveBar />}
                      <item.icon aria-hidden className="size-4 shrink-0" />
                      {t(item.label)}
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

const ActiveBar = () => (
  <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-full bg-primary" />
);

/** An item whose pages are listed under it (Inventory): opens by itself while one of its pages is current. */
function Submenu({
  item,
  pages,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pages: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const t = useT();
  const listId = useId();
  // Only the item's own pages count: /catalog is Catalog's page, not Inventory's.
  const own = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const current = own ? activeNavItem(pages, pathname) : undefined;
  const [open, setOpen] = useState(current !== undefined);
  const Icon = item.icon;

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        data-testid={`nav-${item.id}`}
        className={cn(ITEM_CLASS, current && 'text-primary')}
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="flex-1 text-left">{t(item.label)}</span>
        <ChevronDown
          aria-hidden
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <ul id={listId} className="ml-5 flex flex-col gap-0.5 border-l py-1 pl-2">
          {pages.map((page) => {
            const active = page.id === current?.id;
            return (
              <li key={page.id}>
                <Link
                  href={page.href}
                  data-testid={`nav-${page.id}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={onNavigate}
                  className={cn(
                    'flex min-h-10 items-center gap-2.5 rounded-md px-3 text-sm text-muted-foreground no-underline hover:bg-muted hover:text-foreground hover:no-underline',
                    active && 'bg-muted font-medium text-foreground ring-1 ring-primary',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full bg-muted-foreground',
                      active && 'bg-primary',
                    )}
                  />
                  {t(page.label)}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
