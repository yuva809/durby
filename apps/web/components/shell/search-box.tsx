'use client';

import type { LabelKey } from '@durby/i18n';
import { SEARCH_RESULT_TYPES, type SearchResult } from '@durby/shared';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { navLayout } from '../../lib/nav/layouts';
import { type NavItem, visibleNav } from '../../lib/nav/registry';
import { cn } from '../../lib/utils';
import { camel, loadSearch, resultHref } from '../../lib/workspace/api';
import { useNavLayout } from '../theme-provider';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';

interface Entry {
  key: string;
  group: string;
  title: string;
  subtitle: string | null;
  href: string;
}

/** Every page the person can open: menu items and their pages (settings tabs, inventory pages). */
function pagesOf(items: readonly NavItem[], access: Parameters<typeof visibleNav>[1]): NavItem[] {
  return visibleNav(items, access).flatMap((item) =>
    item.children ? [item, ...pagesOf(item.children, access)] : [item],
  );
}

/**
 * The top bar's search (docs/platform/web-shell.md → Search, ADR 0046): a box that opens a palette, also on Ctrl+K /
 * ⌘K. Pages of the menu match as you type; from two letters the api adds records (items, products, customers, orders,
 * requests, staff) the person may see. Arrow keys and Enter pick; Escape closes.
 */
export function SearchBox() {
  const t = useT();
  const router = useRouter();
  const { store, session } = useAuth();
  // The same menu as the sidebar: a branch finds its own pages (ADR 0059).
  const layout = navLayout(
    useNavLayout(),
    session
      ? { activeFeatures: session.activeFeatures, activePermissions: session.activePermissions }
      : undefined,
  );
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // The answer and the query it belongs to: an answer for an older query is never shown.
  const [answer, setAnswer] = useState<{ q: string; data: SearchResult[] }>({ q: '', data: [] });
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Records: from two letters, a quarter second after typing stops; a stale answer is dropped.
  const query = q.trim();
  useEffect(() => {
    if (!open || query.length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      void loadSearch(store, query).then((result) => {
        if (current) setAnswer({ q: query, data: result.ok ? result.data : [] });
      });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query, store]);

  const records = useMemo(
    () => (open && query.length >= 2 && answer.q === query ? answer.data : []),
    [answer, open, query],
  );

  const pages = useMemo(() => {
    if (!session) return [];
    const access = {
      activeFeatures: session.activeFeatures,
      activePermissions: session.activePermissions,
    };
    const seen = new Set<string>();
    return pagesOf(layout.items, access).filter((p) => {
      if (seen.has(p.href)) return false;
      seen.add(p.href);
      return true;
    });
  }, [layout.items, session]);

  const entries: Entry[] = useMemo(() => {
    const lower = query.toLowerCase();
    const pageEntries = pages
      .filter((p) => lower === '' || t(p.label).toLowerCase().includes(lower))
      .slice(0, 8)
      .map((p) => ({
        key: `page:${p.id}`,
        group: t('platform.search.groups.pages'),
        title: t(p.label),
        subtitle: null,
        href: p.href,
      }));
    const recordEntries = SEARCH_RESULT_TYPES.flatMap((type) =>
      records
        .filter((r) => r.type === type)
        .map((r) => ({
          key: `${r.type}:${r.id}`,
          group: t(`platform.search.groups.${camel(type)}` as LabelKey),
          title: r.title,
          subtitle: r.subtitle,
          href: resultHref(r),
        })),
    );
    return [...pageEntries, ...recordEntries];
  }, [pages, query, records, t]);

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    setOpen(false);
    setQ('');
    router.push(entry.href);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, entries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(entries[active]);
    }
  };

  if (!session) return null;
  let lastGroup = '';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground hover:bg-muted sm:max-w-md"
        aria-label={t('platform.search.open')}
        data-testid="search-open"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{t('platform.search.placeholder')}</span>
        <kbd className="ml-auto hidden rounded border px-1.5 text-xs sm:inline">Ctrl K</kbd>
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQ('');
          setActive(0);
        }}
      >
        <DialogContent
          closeLabel={t('platform.common.close')}
          aria-describedby={undefined}
          className="top-[15%] translate-y-0 gap-0 p-0 sm:max-w-xl"
        >
          <DialogTitle className="sr-only">{t('platform.search.open')}</DialogTitle>
          <div className="flex items-center gap-2 border-b px-4">
            <Search aria-hidden className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value.slice(0, 100));
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={t('platform.search.placeholder')}
              className="h-12 flex-1 bg-transparent text-sm outline-none"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={entries[active] ? `${listId}-${active}` : undefined}
              aria-label={t('platform.search.placeholder')}
              data-testid="search-input"
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            className="max-h-96 overflow-y-auto p-2"
            data-testid="search-results"
          >
            {entries.length === 0 && (
              <li
                className="px-3 py-6 text-center text-sm text-muted-foreground"
                role="presentation"
              >
                {t(query.length < 2 ? 'platform.search.hint' : 'platform.search.none')}
              </li>
            )}
            {entries.map((entry, i) => {
              const heading = entry.group !== lastGroup;
              lastGroup = entry.group;
              return (
                <li key={entry.key} role="presentation">
                  {heading && (
                    <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground uppercase">
                      {entry.group}
                    </p>
                  )}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(entry)}
                    className={cn(
                      'flex min-h-11 cursor-pointer flex-col justify-center rounded-md px-3 py-1.5 text-sm',
                      i === active && 'bg-muted',
                    )}
                    data-testid="search-result"
                  >
                    <span className="font-medium">{entry.title}</span>
                    {entry.subtitle && (
                      <span className="text-xs text-muted-foreground">{entry.subtitle}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
