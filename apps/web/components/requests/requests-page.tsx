'use client';

import {
  STOCK_REQUEST_DONE,
  STOCK_REQUEST_ON_THE_WAY,
  STOCK_REQUEST_TO_PICK,
  type StockRequest,
  type StockRequestStatus,
} from '@durby/shared';
import { ClipboardList, Plus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  approveRequest,
  cancelRequest,
  loadRequest,
  loadRequests,
  receiveRequest,
  rejectRequest,
} from '../../lib/orders/requests-api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';
import { Loaded, NoAccess } from '../users/common';
import {
  NoteDialog,
  QuantitiesDialog,
  RequestFacts,
  RequestStatusBadge,
  requestTitle,
} from './common';

const TABS = {
  open: ['submitted'],
  progress: [...STOCK_REQUEST_TO_PICK, ...STOCK_REQUEST_ON_THE_WAY],
  done: STOCK_REQUEST_DONE,
} as const satisfies Record<string, readonly StockRequestStatus[]>;
type Tab = keyof typeof TABS;

/**
 * /requests, Stock Requests (docs/modules/orders.md → Branch requests, ADR 0045): a branch's own requests, or all of
 * them for owners and admins, by stage. A request opens in a side panel with its quantities and timeline and the
 * steps the caller may take: approve or reject, cancel, confirm receipt.
 */
export function RequestsPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('orders.requests.read') && !permissions.has('orders.requests.approve'))
    return <NoAccess title="platform.nav.stockRequests" />;
  return <Requests organizationId={session.activeOrganizationId} permissions={permissions} />;
}

function Requests({
  organizationId,
  permissions,
}: {
  organizationId: string | null;
  permissions: ReadonlySet<string>;
}) {
  const t = useT();
  const { store } = useAuth();
  const [tab, setTab] = useState<Tab>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [requests, reload] = useResource(
    organizationId === null ? null : `${organizationId}:${tab}`,
    () => loadRequests(store, { status: TABS[tab] }),
  );
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    [],
  );
  const formatTime = (iso: string) => time.format(new Date(iso));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.nav.stockRequests')}</h1>
          <p className="text-muted-foreground">{t('orders.requestsPage.intro')}</p>
        </div>
        {permissions.has('orders.requests.create') && (
          <Button asChild>
            <Link href="/requests/new" data-testid="requests-new">
              <Plus aria-hidden />
              {t('orders.requestsPage.newRequest')}
            </Link>
          </Button>
        )}
      </div>
      <Card className="flex flex-col gap-0 p-0">
        <div role="tablist" className="flex flex-wrap gap-1 border-b p-3">
          {(Object.keys(TABS) as Tab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={key === tab}
              onClick={() => setTab(key)}
              className={cn(
                'min-h-11 rounded-md px-4 text-sm font-medium hover:bg-muted',
                key === tab && 'bg-muted text-primary ring-1 ring-primary',
              )}
              data-testid={`requests-tab-${key}`}
            >
              {t(`orders.requestsPage.tabs.${key}`)}
            </button>
          ))}
        </div>
        <Loaded resource={requests} reload={reload}>
          {(list) =>
            list.length === 0 ? (
              <div
                className="flex flex-col items-center gap-2 px-6 py-12 text-center"
                data-testid="requests-empty"
              >
                <ClipboardList aria-hidden className="size-8 text-muted-foreground" />
                <p className="text-muted-foreground">{t('orders.requestsPage.empty')}</p>
              </div>
            ) : (
              <ul className="divide-y" data-testid="requests-list">
                {list.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="flex min-h-11 w-full flex-col gap-1 px-4 py-3 text-left hover:bg-muted/50"
                      aria-label={t('orders.requestsPage.open', { number: requestTitle(r) })}
                      onClick={() => setOpenId(r.id)}
                      data-testid="request-row"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{requestTitle(r)}</span>
                        <RequestStatusBadge status={r.status} />
                        {r.transferNumber && (
                          <span className="text-xs text-muted-foreground">
                            {t('orders.transfers.for', { number: r.number })}
                          </span>
                        )}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {t('orders.requestsPage.route', {
                          from: r.fromWarehouseName,
                          to: `${r.locationName} · ${r.toWarehouseName}`,
                        })}{' '}
                        · {t('orders.requestsPage.items', { count: String(r.lineCount) })} ·{' '}
                        {formatTime(r.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      </Card>
      <RequestPanel
        id={openId}
        permissions={permissions}
        onClose={() => setOpenId(null)}
        onChanged={reload}
        formatTime={formatTime}
      />
    </div>
  );
}

function RequestPanel({
  id,
  permissions,
  onClose,
  onChanged,
  formatTime,
}: {
  id: string | null;
  permissions: ReadonlySet<string>;
  onClose: () => void;
  onChanged: () => void;
  formatTime: (iso: string) => string;
}) {
  const t = useT();
  const { store } = useAuth();
  const [request, reload] = useResource(id, () => loadRequest(store, id ?? ''));
  const changed = () => {
    reload();
    onChanged();
  };
  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        closeLabel={t('orders.requestsPage.close')}
        className="w-full overflow-y-auto p-5 sm:max-w-2xl"
        data-testid="request-panel"
      >
        {request.status !== 'ready' && <SheetTitle>{t('platform.nav.stockRequests')}</SheetTitle>}
        <Loaded resource={request} reload={reload}>
          {(r) => (
            <div className="flex flex-col gap-5 pr-8">
              <div className="flex flex-wrap items-center gap-3">
                <SheetTitle className="not-sr-only text-xl font-semibold">
                  {requestTitle(r)}
                </SheetTitle>
                <RequestStatusBadge status={r.status} />
              </div>
              <Actions request={r} permissions={permissions} onDone={changed} />
              <RequestFacts request={r} formatTime={formatTime} />
            </div>
          )}
        </Loaded>
      </SheetContent>
    </Sheet>
  );
}

function Actions({
  request: r,
  permissions,
  onDone,
}: {
  request: StockRequest;
  permissions: ReadonlySet<string>;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const approveAction = useActionKey();
  const rejectAction = useActionKey();
  const cancelAction = useActionKey();
  const receiveAction = useActionKey();
  const submitted = r.status === 'submitted';
  const receivable = ['packed', 'in_transit', 'delivered'].includes(r.status);
  const sent = r.lines.filter(
    (l) => l.pickedQuantity !== null && !/^0(\.0+)?$/.test(l.pickedQuantity),
  );
  const actions = [
    submitted && permissions.has('orders.requests.approve') && (
      <QuantitiesDialog
        key="approve"
        trigger={t('orders.requestsPage.approve')}
        testId="request-approve"
        title={t('orders.requestsPage.approveTitle', { number: r.number })}
        hint={t('orders.requestsPage.approveHint')}
        submitLabel={t('orders.requestsPage.approve')}
        referenceLabel={t('orders.requestsPage.requested')}
        inputLabel={(name) => t('orders.requestsPage.send', { name })}
        lines={r.lines.map((l) => ({
          id: l.id,
          name: l.itemName,
          unit: l.unit,
          reference: l.quantity,
          max: null,
          initial: l.quantity.replace(/\.?0+$/, ''),
        }))}
        run={(lines) => approveRequest(store, approveAction, r.id, { lines })}
        onDone={onDone}
      />
    ),
    submitted && permissions.has('orders.requests.approve') && (
      <NoteDialog
        key="reject"
        trigger={t('orders.requestsPage.reject')}
        testId="request-reject"
        title={t('orders.requestsPage.rejectTitle', { number: r.number })}
        label={t('orders.requestsPage.reason')}
        submitLabel={t('orders.requestsPage.reject')}
        run={(note) => rejectRequest(store, rejectAction, r.id, note ? { note } : {})}
        onDone={onDone}
      />
    ),
    submitted && permissions.has('orders.requests.create') && (
      <NoteDialog
        key="cancel"
        trigger={t('orders.requestsPage.cancel')}
        testId="request-cancel"
        title={t('orders.requestsPage.cancelTitle', { number: r.number })}
        label={t('orders.requestsPage.reason')}
        submitLabel={t('orders.requestsPage.cancel')}
        run={(note) => cancelRequest(store, cancelAction, r.id, note ? { note } : {})}
        onDone={onDone}
      />
    ),
    receivable && permissions.has('orders.requests.receive') && sent.length > 0 && (
      <QuantitiesDialog
        key="receive"
        trigger={t('orders.requestsPage.receive')}
        testId="request-receive"
        title={t('orders.requestsPage.receiveTitle', { number: requestTitle(r) })}
        hint={t('orders.requestsPage.receiveHint')}
        submitLabel={t('orders.requestsPage.receive')}
        referenceLabel={t('orders.requestsPage.picked')}
        inputLabel={(name) => t('orders.requestsPage.arrived', { name })}
        lines={sent.map((l) => ({
          id: l.id,
          name: l.itemName,
          unit: l.unit,
          reference: l.pickedQuantity!,
          max: l.pickedQuantity,
          initial: l.pickedQuantity!.replace(/\.?0+$/, ''),
        }))}
        run={(lines) => receiveRequest(store, receiveAction, r.id, { lines })}
        onDone={onDone}
      />
    ),
  ].filter(Boolean);
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="request-actions">
      {actions}
    </div>
  );
}
