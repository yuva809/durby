'use client';

import {
  STOCK_REQUEST_ON_THE_WAY,
  STOCK_REQUEST_TO_PICK,
  type StockRequestStatus,
  type StockRequestSummary,
} from '@durby/shared';
import { Check, Truck } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadRequests } from '../../lib/orders/requests-api';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Loaded } from '../users/common';
import { RequestStatusBadge, requestTitle, statusKey } from './common';

/** The steps an approved request goes through on its way to the branch. */
const STEPS = [
  'approved',
  'picking',
  'packed',
  'in_transit',
  'delivered',
] as const satisfies readonly StockRequestStatus[];
/** From packed on, the branch can confirm what arrived. */
const RECEIVABLE: readonly StockRequestStatus[] = ['packed', 'in_transit', 'delivered'];
const RECENT_DAYS = 7;

/**
 * Delivery Tracking for a branch (ADR 0059): its requests from approval to its door, each with the step it is at and
 * the driver once one is assigned, "Confirm receipt" from packed on (in the request's panel on /requests); below, what
 * arrived in the last 7 days.
 */
export function BranchDeliveries({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  // Fixed per visit, so "the last 7 days" doesn't move between renders.
  const [since] = useState(() => Date.now() - RECENT_DAYS * 86_400_000);
  const [open, reloadOpen] = useResource(organizationId, () =>
    loadRequests(store, { status: [...STOCK_REQUEST_TO_PICK, ...STOCK_REQUEST_ON_THE_WAY] }),
  );
  const [received, reloadReceived] = useResource(
    organizationId === null ? null : `${organizationId}:received`,
    () => loadRequests(store, { status: ['received'] }),
  );
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    [],
  );
  const formatTime = (iso: string) => time.format(new Date(iso));
  const days = String(RECENT_DAYS);

  return (
    <div className="flex flex-col gap-6" data-testid="branch-deliveries">
      <div className="flex max-w-3xl flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('platform.nav.deliveries')}</h1>
        <p className="text-muted-foreground">{t('orders.branchDeliveries.intro')}</p>
      </div>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t('orders.branchDeliveries.onTheWay')}</h2>
        <Loaded resource={open} reload={reloadOpen}>
          {(rows) =>
            rows.length === 0 ? (
              <Card
                className="flex flex-col items-center gap-2 px-6 py-12 text-center"
                data-testid="branch-deliveries-empty"
              >
                <Truck aria-hidden className="size-8 text-muted-foreground" />
                <p className="text-muted-foreground">{t('orders.branchDeliveries.empty')}</p>
              </Card>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {rows.map((r) => (
                  <TrackingCard key={r.id} request={r} when={formatTime(r.updatedAt)} />
                ))}
              </ul>
            )
          }
        </Loaded>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t('orders.branchDeliveries.received', { days })}</h2>
        <Loaded resource={received} reload={reloadReceived}>
          {(rows) => {
            const recent = rows.filter((r) => Date.parse(r.updatedAt) >= since);
            return recent.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="branch-received-empty">
                {t('orders.branchDeliveries.noneReceived', { days })}
              </p>
            ) : (
              <ul className="divide-y rounded-lg border bg-card" data-testid="branch-received">
                {recent.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                  >
                    <Link href={`/requests?open=${r.id}`} className="font-medium">
                      {requestTitle(r)}
                    </Link>
                    <span className="text-muted-foreground">
                      {t('orders.requestsPage.items', { count: String(r.lineCount) })} ·{' '}
                      {formatTime(r.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            );
          }}
        </Loaded>
      </section>
    </div>
  );
}

function TrackingCard({ request: r, when }: { request: StockRequestSummary; when: string }) {
  const t = useT();
  const current = (STEPS as readonly StockRequestStatus[]).indexOf(r.status);
  return (
    <li>
      <Card className="flex h-full flex-col gap-4 p-4" data-testid="tracking-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">{requestTitle(r)}</span>
          <RequestStatusBadge status={r.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t('orders.branchDeliveries.from', {
            warehouse: `${r.fromLocationName} · ${r.fromWarehouseName}`,
          })}
          <br />
          {t('orders.requestsPage.items', { count: String(r.lineCount) })} · {when}
          {r.driverName && (
            <>
              <br />
              {t('orders.branchDeliveries.driver', { name: r.driverName })}
            </>
          )}
        </p>
        <ol
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          aria-label={t('orders.branchDeliveries.steps')}
          data-testid="tracking-steps"
        >
          {STEPS.map((step, index) => {
            const done = index <= current;
            return (
              <li
                key={step}
                className={cn(
                  'flex items-center gap-1',
                  done ? 'font-semibold text-primary' : 'text-muted-foreground',
                )}
                aria-current={index === current ? 'step' : undefined}
                data-done={done}
              >
                {done ? (
                  <Check aria-hidden className="size-3.5" />
                ) : (
                  <span aria-hidden className="size-2 rounded-full bg-muted-foreground/40" />
                )}
                {t(`orders.requestStatus.${statusKey(step)}`)}
              </li>
            );
          })}
        </ol>
        {RECEIVABLE.includes(r.status) && (
          <div className="mt-auto flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/requests?open=${r.id}`} data-testid="tracking-receive">
                {t('orders.requestsPage.receive')}
              </Link>
            </Button>
            {/* The Delivery Challan to check the goods against (ADR 0064). */}
            <Button variant="outline" asChild>
              <Link
                href={`/requests/${r.id}/dc`}
                target="_blank"
                rel="noopener"
                data-testid="tracking-dc"
              >
                {t('orders.documents.dc')}
              </Link>
            </Button>
          </div>
        )}
      </Card>
    </li>
  );
}
