'use client';

import type { LabelKey } from '@durby/i18n';
import type { AttentionResponse } from '@durby/shared';
import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { ATTENTION_HREF, camel, loadAttention } from '../../lib/workspace/api';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

/** How often the count is asked again while the page is open. */
export const ATTENTION_REFRESH_MS = 60_000;

/**
 * The bell (docs/platform/web-shell.md → Notifications, ADR 0046): what waits for the signed-in person, worked out by
 * the api from data they can see. The count refreshes every minute, when the tab comes back and when the menu opens;
 * an item goes once it's done. Nothing to mark as read.
 */
export function NotificationsBell() {
  const t = useT();
  const router = useRouter();
  const { store, session } = useAuth();
  const organizationId = session?.activeOrganizationId ?? null;
  const [data, setData] = useState<AttentionResponse | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (organizationId === null) return;
    let current = true;
    void loadAttention(store).then((result) => {
      if (current && result.ok) setData(result.data);
    });
    return () => {
      current = false;
    };
  }, [organizationId, store, tick]);

  useEffect(() => {
    const refresh = () => setTick((n) => n + 1);
    const timer = setInterval(refresh, ATTENTION_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!session) return null;
  const total = data?.total ?? 0;
  const label =
    total > 0
      ? t('platform.attention.buttonWithCount', { count: String(total) })
      : t('platform.attention.button');

  return (
    <DropdownMenu onOpenChange={(open) => open && setTick((n) => n + 1)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={label}
          data-testid="attention-bell"
        >
          <Bell aria-hidden />
          {total > 0 && (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[0.65rem] font-semibold text-primary-foreground"
              data-testid="attention-count"
            >
              {total > 99 ? '99+' : total}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{t('platform.attention.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(data?.data.length ?? 0) === 0 ? (
          <p
            className="px-2 py-4 text-center text-sm text-muted-foreground"
            data-testid="attention-empty"
          >
            {t('platform.attention.empty')}
          </p>
        ) : (
          data!.data.map((item) => (
            <DropdownMenuItem
              key={item.kind}
              onSelect={() => router.push(ATTENTION_HREF[item.kind])}
              className="flex items-center justify-between gap-3"
              data-testid="attention-item"
            >
              <span>
                {t(`platform.attention.kinds.${camel(item.kind)}` as LabelKey, {
                  count: String(item.count),
                })}
              </span>
              <span className="rounded-full bg-muted px-2 text-xs font-semibold tabular-nums">
                {item.count}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
