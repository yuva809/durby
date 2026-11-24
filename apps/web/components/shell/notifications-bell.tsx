'use client';

import type { LabelKey } from '@durby/i18n';
import {
  type AttentionResponse,
  type Notification,
  type NotificationListResponse,
  notificationText,
} from '@durby/shared';
import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  ATTENTION_HREF,
  camel,
  loadAttention,
  loadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationHref,
} from '../../lib/workspace/api';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

/** How often the counts are asked again while the page is open. */
export const ATTENTION_REFRESH_MS = 60_000;

type Tab = 'waiting' | 'updates';

/**
 * The bell (docs/platform/web-shell.md → Notifications, ADR 0046 / 0047). Two tabs: "Waiting for me" is worked out by
 * the api from data the person can see (an item goes once it's done); "Updates" are the stored notifications about
 * things that happened, with an unread count and mark read. The badge adds both. Both refresh every minute, when the
 * tab comes back and when the menu opens.
 */
export function NotificationsBell() {
  const t = useT();
  const router = useRouter();
  const { store, session } = useAuth();
  const organizationId = session?.activeOrganizationId ?? null;
  const [waiting, setWaiting] = useState<AttentionResponse | null>(null);
  const [updates, setUpdates] = useState<NotificationListResponse | null>(null);
  const [tab, setTab] = useState<Tab>('waiting');
  const [tick, setTick] = useState(0);
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }),
    [],
  );

  useEffect(() => {
    if (organizationId === null) return;
    let current = true;
    void loadAttention(store).then((result) => {
      if (current && result.ok) setWaiting(result.data);
    });
    void loadNotifications(store).then((result) => {
      if (current && result.ok) setUpdates(result.data);
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
  const waitingTotal = waiting?.total ?? 0;
  const unread = updates?.unread ?? 0;
  const total = waitingTotal + unread;
  const label =
    total > 0
      ? t('platform.attention.buttonWithCount', { count: String(total) })
      : t('platform.attention.button');

  /** `id` null marks every update. */
  const markLocally = (id: string | null) =>
    setUpdates((current) =>
      current === null
        ? current
        : {
            unread: id === null ? 0 : Math.max(0, current.unread - 1),
            data: current.data.map((n) =>
              id === null || n.id === id
                ? { ...n, readAt: n.readAt ?? new Date().toISOString() }
                : n,
            ),
          },
    );

  const openUpdate = (n: Notification) => {
    if (n.readAt === null) {
      markLocally(n.id);
      void markNotificationRead(store, n.id);
    }
    const href = notificationHref(n);
    if (href) router.push(href);
  };

  const readAll = () => {
    markLocally(null);
    void markAllNotificationsRead(store);
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) return;
        // Open where something is: updates when only they have news.
        if (waitingTotal === 0 && unread > 0) setTab('updates');
        setTick((n) => n + 1);
      }}
    >
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
      <DropdownMenuContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-2">
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="waiting" className="justify-center" data-testid="bell-tab-waiting">
              {t('platform.attention.title')}
              {waitingTotal > 0 && <Count value={waitingTotal} />}
            </TabsTrigger>
            <TabsTrigger value="updates" className="justify-center" data-testid="bell-tab-updates">
              {t('platform.notifications.title')}
              {unread > 0 && <Count value={unread} />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="waiting" className="mt-2">
            {(waiting?.data.length ?? 0) === 0 ? (
              <Empty testId="attention-empty">{t('platform.attention.empty')}</Empty>
            ) : (
              waiting!.data.map((item) => (
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
                  <Count value={item.count} />
                </DropdownMenuItem>
              ))
            )}
          </TabsContent>

          <TabsContent value="updates" className="mt-2">
            {(updates?.data.length ?? 0) === 0 ? (
              <Empty testId="updates-empty">{t('platform.notifications.empty')}</Empty>
            ) : (
              <>
                <div className="max-h-96 overflow-y-auto">
                  {updates!.data.map((n) => {
                    const text = notificationText(t, n, session.user.locale);
                    return (
                      <DropdownMenuItem
                        key={n.id}
                        onSelect={() => openUpdate(n)}
                        className="flex items-start gap-2"
                        data-testid="update-item"
                        data-unread={n.readAt === null ? 'true' : undefined}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'mt-1.5 size-2 shrink-0 rounded-full',
                            n.readAt === null ? 'bg-primary' : 'bg-transparent',
                          )}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className={cn(n.readAt === null && 'font-medium')}>
                            {text.title}
                          </span>
                          {text.body ? <span className="text-sm">{text.body}</span> : null}
                          <span className="text-xs text-muted-foreground">
                            {n.readAt === null && (
                              <span className="sr-only">{t('platform.notifications.unread')} </span>
                            )}
                            {time.format(new Date(n.createdAt))}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </div>
                {unread > 0 && (
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      readAll();
                    }}
                    className="mt-1 justify-center text-sm font-medium"
                    data-testid="updates-read-all"
                  >
                    {t('platform.notifications.markAllRead')}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Count({ value }: { value: number }) {
  return (
    <span className="ml-1.5 rounded-full bg-muted px-2 text-xs font-semibold tabular-nums">
      {value > 99 ? '99+' : value}
    </span>
  );
}

function Empty({ testId, children }: { testId: string; children: string }) {
  return (
    <p className="px-2 py-4 text-center text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}
