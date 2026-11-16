'use client';

import {
  STOCK_REQUEST_ON_THE_WAY,
  STOCK_REQUEST_TO_PICK,
  type StockRequestStatus,
  type StockRequestSummary,
} from '@durby/shared';
import { ChevronRight, Package, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import {
  assignDriver,
  loadDrivers,
  loadRequest,
  loadRequests,
  packRequest,
  startPickingRequest,
} from '../../lib/orders/requests-api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { ConfirmAction, Loaded } from '../users/common';
import { QuantitiesDialog, RequestStatusBadge } from './common';

const TABS = {
  toPick: STOCK_REQUEST_TO_PICK,
  packed: STOCK_REQUEST_ON_THE_WAY,
  received: ['received'],
} as const satisfies Record<string, readonly StockRequestStatus[]>;
type Tab = keyof typeof TABS;

/**
 * The warehouse's side of branch requests on the Picking page (docs/modules/orders.md → Branch requests, ADR 0045):
 * approved transfers to pick, oldest first; packed ones on their way; received ones. Picking records what came off
 * the shelves (short allowed) and moves it to In transit; a driver can be assigned then or later.
 */
export function TransfersPicking({
  organizationId,
  initialTab = 'toPick',
}: {
  organizationId: string | null;
  initialTab?: 'toPick' | 'packed' | 'received';
}) {
  const t = useT();
  const { store, session } = useAuth();
  const id = useId();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState('');
  const canAssign = session?.activePermissions.includes('orders.delivery.assign') ?? false;
  const [list, reload] = useResource(
    organizationId === null ? null : `${organizationId}:${tab}`,
    () => loadRequests(store, { status: TABS[tab] }),
  );
  const date = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }), []);

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {t('orders.transfers.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('orders.transfers.intro')}</p>
      </div>
      <Card className="flex flex-col gap-0 p-0">
        <div className="flex flex-wrap items-center gap-3 border-b p-3">
          <div role="tablist" className="flex gap-1 rounded-lg bg-muted p-1">
            {(Object.keys(TABS) as Tab[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={key === tab}
                onClick={() => setTab(key)}
                className={cn(
                  'min-h-10 rounded-md px-4 text-sm font-medium',
                  key === tab ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground',
                )}
                data-testid={`transfers-tab-${key}`}
              >
                {t(`orders.transfers.tabs.${key}`)}
              </button>
            ))}
          </div>
          <div className="relative min-w-56 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              className="pl-9"
              aria-label={t('orders.transfers.search')}
              placeholder={t('orders.transfers.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="transfers-search"
            />
          </div>
        </div>
        <Loaded resource={list} reload={reload}>
          {(rows) => {
            const q = search.trim().toLowerCase();
            const shown = [...rows]
              // Oldest first: the branch that has waited longest is served first.
              .reverse()
              .filter(
                (r) =>
                  q === '' ||
                  r.number.toLowerCase().includes(q) ||
                  (r.transferNumber ?? '').toLowerCase().includes(q),
              );
            if (shown.length === 0) {
              return (
                <p className="p-4 text-sm text-muted-foreground" data-testid="transfers-empty">
                  {t('orders.transfers.empty')}
                </p>
              );
            }
            return (
              <ul className="divide-y" data-testid="transfers-list">
                {shown.map((r) => (
                  <TransferRow
                    key={r.id}
                    request={r}
                    canAssign={canAssign}
                    date={date.format(new Date(r.updatedAt))}
                    onDone={reload}
                  />
                ))}
              </ul>
            );
          }}
        </Loaded>
      </Card>
    </section>
  );
}

function TransferRow({
  request: r,
  canAssign,
  date,
  onDone,
}: {
  request: StockRequestSummary;
  canAssign: boolean;
  date: string;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const startAction = useActionKey();
  const title = r.transferNumber ?? r.number;
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="transfer-row">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-primary"
      >
        <Package className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{title}</span>
          <RequestStatusBadge status={r.status} />
          <span className="text-xs text-muted-foreground">
            {t('orders.transfers.for', { number: r.number })}
          </span>
        </span>
        <span className="text-sm text-muted-foreground">
          {t('orders.requestsPage.route', {
            from: r.fromWarehouseName,
            to: `${r.locationName} · ${r.toWarehouseName}`,
          })}{' '}
          · {t('orders.requestsPage.items', { count: String(r.lineCount) })} · {date}
          {r.driverName && ` · ${t('orders.requestsPage.driver', { name: r.driverName })}`}
        </span>
      </span>
      <span className="flex flex-wrap gap-2">
        {r.status === 'approved' && (
          <ConfirmAction
            testId="transfer-start"
            trigger={t('orders.transfers.start')}
            title={t('orders.transfers.packTitle', { number: title })}
            description={t('orders.transfers.intro')}
            confirm={t('orders.transfers.start')}
            run={() => startPickingRequest(store, startAction, r.id, {})}
            onDone={onDone}
          />
        )}
        {(r.status === 'approved' || r.status === 'picking') && (
          <PackDialog request={r} canAssign={canAssign} onDone={onDone} />
        )}
        {canAssign && (r.status === 'packed' || r.status === 'in_transit') && (
          <AssignDialog request={r} onDone={onDone} />
        )}
      </span>
      <ChevronRight aria-hidden className="hidden size-4 text-muted-foreground sm:block" />
    </li>
  );
}

function DriverSelect({
  warehouseId,
  value,
  onChange,
  allowNone,
}: {
  warehouseId: string;
  value: string;
  onChange: (value: string) => void;
  allowNone: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const id = useId();
  const [drivers] = useResource(warehouseId, () => loadDrivers(store, warehouseId));
  return (
    <Field id={`${id}-driver`} label={t('orders.transfers.driver')} problem={null}>
      <Select
        id={`${id}-driver`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="transfer-driver"
      >
        {allowNone && <option value="">{t('orders.transfers.assignLater')}</option>}
        {drivers.status === 'ready' &&
          drivers.data.map((d) => (
            <option key={d.userId} value={d.userId}>
              {d.name || d.userId.slice(0, 8)}
            </option>
          ))}
      </Select>
    </Field>
  );
}

/** Pick: the request's approved lines with what came off the shelves; then packed, optionally with a driver. */
function PackDialog({
  request: r,
  canAssign,
  onDone,
}: {
  request: StockRequestSummary;
  canAssign: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [driver, setDriver] = useState('');
  const [detail] = useResource(r.id, () => loadRequest(store, r.id));
  if (detail.status !== 'ready') return null;
  const lines = detail.data.lines.filter(
    (l) => l.approvedQuantity !== null && !/^0(\.0+)?$/.test(l.approvedQuantity),
  );
  return (
    <QuantitiesDialog
      trigger={t('orders.transfers.pick')}
      triggerVariant={r.status === 'picking' ? 'default' : 'outline'}
      testId="transfer-pack"
      title={t('orders.transfers.packTitle', { number: r.transferNumber ?? r.number })}
      hint={t('orders.transfers.stockNote', { warehouse: r.fromWarehouseName })}
      submitLabel={t('orders.transfers.submit')}
      referenceLabel={t('orders.requestsPage.approved')}
      inputLabel={(name) => t('orders.transfers.pickedOf', { name })}
      lines={lines.map((l) => ({
        id: l.id,
        name: l.itemName,
        unit: l.unit,
        reference: l.approvedQuantity!,
        max: l.approvedQuantity,
        initial: l.approvedQuantity!.replace(/\.?0+$/, ''),
      }))}
      run={(quantities) =>
        packRequest(store, action, r.id, {
          lines: quantities,
          ...(driver ? { driverUserId: driver } : {}),
        })
      }
      onDone={onDone}
    >
      {canAssign && (
        <DriverSelect
          warehouseId={r.fromWarehouseId}
          value={driver}
          onChange={setDriver}
          allowNone
        />
      )}
    </QuantitiesDialog>
  );
}

function AssignDialog({
  request: r,
  onDone,
}: {
  request: StockRequestSummary;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const [driver, setDriver] = useState('');
  return (
    <FormDialog
      trigger={t('orders.transfers.assign')}
      triggerVariant="outline"
      testId="transfer-assign"
      title={t('orders.transfers.assignTitle', { number: r.transferNumber ?? r.number })}
      submitLabel={t('orders.transfers.assign')}
      onOpen={() => setDriver(r.driverUserId ?? '')}
      submit={() => (driver ? assignDriver(store, action, r.id, { driverUserId: driver }) : null)}
      onDone={onDone}
    >
      <DriverSelect warehouseId={r.fromWarehouseId} value={driver} onChange={setDriver} allowNone />
    </FormDialog>
  );
}
