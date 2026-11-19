'use client';

import {
  STOCK_REQUEST_DONE,
  STOCK_REQUEST_ON_THE_WAY,
  STOCK_REQUEST_TO_PICK,
  type StockRequest,
  type StockRequestStatus,
  type StockRequestSummary,
} from '@durby/shared';
import { ClipboardList, FileText, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadStock } from '../../lib/inventory/api';
import {
  approveRequest,
  cancelRequest,
  loadRequest,
  loadRequests,
  receiveRequest,
  rejectRequest,
} from '../../lib/orders/requests-api';
import { isBranchView } from '../../lib/nav/layouts';
import { pickPlan } from '../../lib/orders/shortage';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { useNavLayout } from '../theme-provider';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';
import { Loaded, NoAccess } from '../users/common';
import { hasDeliveryDocument } from './request-document';
import {
  NoteDialog,
  QuantitiesDialog,
  RequestFacts,
  RequestStatusBadge,
  requestTitle,
} from './common';

/** The status filter (ADR 0059): every request, or one stage. */
const FILTERS = {
  all: null,
  open: ['submitted'],
  progress: [...STOCK_REQUEST_TO_PICK, ...STOCK_REQUEST_ON_THE_WAY],
  done: STOCK_REQUEST_DONE,
} as const satisfies Record<string, readonly StockRequestStatus[] | null>;
type Filter = keyof typeof FILTERS;

/**
 * /requests, Stock Requests (docs/modules/orders.md → Branch requests, ADR 0045, 0059): a branch's own requests (its
 * "Order History"), or all of them for owners and admins, as a table filtered by stage and searched by request or
 * transfer number. A request opens in a side panel with its quantities and timeline and the steps the caller may
 * take: approve or reject, cancel, confirm receipt.
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
  const { store, session } = useAuth();
  const operations = useNavLayout() === 'operations';
  const branch = operations && session !== null && isBranchView(session);
  // Every request at every stage, from sent to received; the filter narrows it (ADR 0059, 0063).
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  // A search result or a link opens one in the side panel (?open=<id>, ADR 0046); a new link opens again.
  const urlOpen = useSearchParams().get('open');
  const [openId, setOpenId] = useState<string | null>(urlOpen);
  const [seenUrl, setSeenUrl] = useState(urlOpen);
  if (urlOpen !== seenUrl) {
    setSeenUrl(urlOpen);
    if (urlOpen) setOpenId(urlOpen);
  }
  const [requests, reload] = useResource(
    organizationId === null ? null : `${organizationId}:${filter}`,
    () => {
      const status = FILTERS[filter];
      return loadRequests(store, status ? { status } : {});
    },
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
          <h1 className="text-2xl font-semibold">
            {t(operations ? 'platform.nav.orderHistory' : 'platform.nav.stockRequests')}
          </h1>
          <p className="text-muted-foreground">
            {t(branch ? 'orders.requestsPage.branchIntro' : 'orders.requestsPage.intro')}
          </p>
        </div>
        {/* Branches send requests; those who approve them don't (item 8). */}
        {permissions.has('orders.requests.create') &&
          !permissions.has('orders.requests.approve') && (
            <Button asChild>
              <Link href="/requests/new" data-testid="requests-new">
                <Plus aria-hidden />
                {t('orders.requestsPage.newRequest')}
              </Link>
            </Button>
          )}
      </div>
      <Card className="flex flex-col gap-0 p-0">
        <div className="flex flex-col gap-3 border-b p-3 sm:flex-row">
          <div className="relative flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('orders.requestsPage.search')}
              aria-label={t('orders.requestsPage.search')}
              className="pl-9"
              data-testid="requests-search"
            />
          </div>
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            aria-label={t('orders.requestsPage.statusFilter')}
            className="sm:w-60"
            data-testid="requests-status"
          >
            {(Object.keys(FILTERS) as Filter[]).map((key) => (
              <option key={key} value={key}>
                {t(
                  key === 'all'
                    ? 'orders.requestsPage.allStatuses'
                    : `orders.requestsPage.tabs.${key}`,
                )}
              </option>
            ))}
          </Select>
        </div>
        <Loaded resource={requests} reload={reload}>
          {(list) => {
            const needle = search.trim().toLowerCase();
            const shown =
              needle === ''
                ? list
                : list.filter(
                    (r) =>
                      r.number.toLowerCase().includes(needle) ||
                      (r.transferNumber ?? '').toLowerCase().includes(needle),
                  );
            return shown.length === 0 ? (
              <div
                className="flex flex-col items-center gap-2 px-6 py-12 text-center"
                data-testid="requests-empty"
              >
                <ClipboardList aria-hidden className="size-8 text-muted-foreground" />
                <p className="text-muted-foreground">
                  {needle === ''
                    ? t('orders.requestsPage.empty')
                    : t('orders.requestsPage.noMatch', { query: search.trim() })}
                </p>
              </div>
            ) : (
              <RequestTable rows={shown} formatTime={formatTime} onOpen={setOpenId} />
            );
          }}
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

/** The requests as a table (ADR 0059): number, branch, items, who asked, when, stage and transfer number. */
function RequestTable({
  rows,
  formatTime,
  onOpen,
}: {
  rows: readonly StockRequestSummary[];
  formatTime: (iso: string) => string;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const head =
    'px-4 py-3 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="requests-list">
        <thead>
          <tr className="border-b">
            <th scope="col" className={head}>
              {t('orders.requestsPage.columns.request')}
            </th>
            <th scope="col" className={cn(head, 'hidden sm:table-cell')}>
              {t('orders.requestsPage.columns.branch')}
            </th>
            <th scope="col" className={cn(head, 'text-right')}>
              {t('orders.requestsPage.columns.items')}
            </th>
            <th scope="col" className={cn(head, 'hidden md:table-cell')}>
              {t('orders.requestsPage.columns.requestedBy')}
            </th>
            <th scope="col" className={cn(head, 'hidden md:table-cell')}>
              {t('orders.requestsPage.columns.date')}
            </th>
            <th scope="col" className={head}>
              {t('orders.requestsPage.columns.status')}
            </th>
            <th scope="col" className={cn(head, 'hidden lg:table-cell')}>
              {t('orders.requestsPage.columns.transfer')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-muted/50" data-testid="request-table-row">
              <td className="px-4 py-2">
                <button
                  type="button"
                  className="min-h-11 text-left font-semibold hover:underline"
                  aria-label={t('orders.requestsPage.open', { number: requestTitle(r) })}
                  onClick={() => onOpen(r.id)}
                  data-testid="request-row"
                >
                  {r.number}
                </button>
                <span className="block pb-1 text-xs text-muted-foreground md:hidden">
                  {formatTime(r.createdAt)}
                </span>
              </td>
              <td className="hidden px-4 py-2 sm:table-cell">{r.locationName}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.lineCount}</td>
              <td className="hidden px-4 py-2 md:table-cell" data-testid="request-requested-by">
                {r.requestedByName ?? '—'}
              </td>
              <td className="hidden px-4 py-2 whitespace-nowrap md:table-cell">
                {formatTime(r.createdAt)}
              </td>
              <td className="px-4 py-2">
                <RequestStatusBadge status={r.status} />
              </td>
              <td className="hidden px-4 py-2 whitespace-nowrap lg:table-cell">
                <DocumentLinks request={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A request's documents in the table (ADR 0064): its Order Confirmation from the start, its Delivery Challan once
 * packed; each opens in a new tab to print or save as PDF.
 */
function DocumentLinks({ request: r }: { request: StockRequestSummary }) {
  const t = useT();
  const link = 'text-primary hover:underline';
  return (
    <span className="flex flex-col text-xs">
      <Link
        href={`/requests/${r.id}/oc`}
        target="_blank"
        rel="noopener"
        className={link}
        data-testid="request-oc-link"
      >
        {t('orders.documents.ocShort')} {r.number}
      </Link>
      {hasDeliveryDocument(r.status) && r.transferNumber ? (
        <Link
          href={`/requests/${r.id}/dc`}
          target="_blank"
          rel="noopener"
          className={link}
          data-testid="request-dc-link"
        >
          {t('orders.documents.dcShort')} {r.transferNumber}
        </Link>
      ) : (
        <span className="text-muted-foreground">{t('orders.documents.dcShort')} —</span>
      )}
    </span>
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
              <div className="flex flex-wrap gap-2" data-testid="request-documents">
                <Button variant="outline" asChild>
                  <Link href={`/requests/${r.id}/oc`} target="_blank" rel="noopener">
                    <FileText aria-hidden />
                    {t('orders.documents.oc')}
                  </Link>
                </Button>
                {hasDeliveryDocument(r.status) && (
                  <Button variant="outline" asChild>
                    <Link href={`/requests/${r.id}/dc`} target="_blank" rel="noopener">
                      <FileText aria-hidden />
                      {t('orders.documents.dc')}
                    </Link>
                  </Button>
                )}
              </div>
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
      <ApproveDialog key="approve" request={r} onDone={onDone} />
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
        quantityLabel={t('orders.requestsPage.arrivedColumn')}
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

/**
 * Approve: each line as asked against what the source warehouse has on hand, read when the dialog opens; a line short
 * of stock starts at what is there and says how much is missing. The quantity to send is the approver's.
 */
function ApproveDialog({ request: r, onDone }: { request: StockRequest; onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [opened, setOpened] = useState(0);
  const [stock] = useResource(opened > 0 ? `${r.fromWarehouseId}:${opened}` : null, () =>
    loadStock(store, { warehouseId: r.fromWarehouseId }),
  );
  const onHand =
    stock.status === 'ready' ? new Map(stock.data.map((l) => [l.itemId, l.quantity])) : null;
  return (
    <QuantitiesDialog
      trigger={t('orders.requestsPage.approve')}
      testId="request-approve"
      title={t('orders.requestsPage.approveTitle', { number: r.number })}
      hint={t('orders.requestsPage.approveHint')}
      submitLabel={t('orders.requestsPage.approve')}
      referenceLabel={t('orders.requestsPage.requested')}
      availableLabel={t('orders.requestsPage.onHand')}
      quantityLabel={t('orders.requestsPage.toSend')}
      inputLabel={(name) => t('orders.requestsPage.send', { name })}
      onOpen={() => setOpened((n) => n + 1)}
      lines={r.lines.map((l) => {
        // An item with no stock row has none.
        const available = onHand ? (onHand.get(l.itemId) ?? '0') : null;
        const plan = pickPlan(l.quantity, available);
        return {
          id: l.id,
          name: l.itemName,
          unit: l.unit,
          reference: l.quantity,
          max: null,
          initial: plan.initial,
          ...(available === null ? {} : { available, short: plan.short }),
        };
      })}
      run={(lines) => approveRequest(store, action, r.id, { lines })}
      onDone={onDone}
    />
  );
}
