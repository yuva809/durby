'use client';

import type {
  ProductCategory,
  StockItem,
  UnitOfMeasure,
  VendorInvoice,
  VendorInvoiceStatus,
  VendorInvoiceSummary,
  Warehouse,
} from '@durby/shared';
import { ArrowLeft, FileText, Inbox } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories } from '../../lib/catalog/api';
import { loadStockItems, loadUnits, loadWarehouses } from '../../lib/inventory/api';
import {
  approveInvoice,
  correctInvoiceLine,
  loadInvoice,
  loadInvoices,
  rejectInvoice,
  updateInvoice,
} from '../../lib/inventory/invoices-api';
import {
  type InvoiceRow,
  NEW_ITEM,
  rowProblems,
  rowsFromInvoice,
  submitRequest,
} from '../../lib/inventory/invoice-receipt';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { Input } from '../ui/input';
import { MoneyProvider, useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { type InvoiceHeader, InvoiceEditor } from './invoice-editor';

const TABS: readonly VendorInvoiceStatus[] = ['pending', 'approved', 'rejected'];

/**
 * /inventory/invoices, the approval queue (docs/modules/inventory.md → Vendor invoices, ADR 0054): vendor invoices
 * read and sent for approval, by status. Opening one shows its lines; while pending it can be corrected, and those
 * with inventory.invoices.approve approve it (one goods receipt, new items created) or reject it with a reason.
 */
export function InvoiceQueuePage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!session.activeFeatures.includes('inventory') || !permissions.has('inventory.stock.read')) {
    return <NoAccess title="inventory.invoices.title" />;
  }
  return (
    <MoneyProvider>
      <Queue
        organizationId={session.activeOrganizationId}
        canApprove={permissions.has('inventory.invoices.approve')}
        canSubmit={permissions.has('inventory.stock.receive')}
        readsCategories={
          session.activeFeatures.includes('catalog') && permissions.has('catalog.products.read')
        }
      />
    </MoneyProvider>
  );
}

function Queue({
  organizationId,
  canApprove,
  canSubmit,
  readsCategories,
}: {
  organizationId: string | null;
  canApprove: boolean;
  canSubmit: boolean;
  readsCategories: boolean;
}) {
  const t = useT();
  const money = useMoney();
  const { store } = useAuth();
  const urlOpen = useSearchParams().get('open');
  const [openId, setOpenId] = useState<string | null>(urlOpen);
  const [seenUrl, setSeenUrl] = useState(urlOpen);
  if (urlOpen !== seenUrl) {
    setSeenUrl(urlOpen);
    if (urlOpen) setOpenId(urlOpen);
  }
  const [tab, setTab] = useState<VendorInvoiceStatus>('pending');
  const [list, reloadList] = useResource(
    organizationId === null ? null : `${organizationId}:${tab}`,
    () => loadInvoices(store, tab),
  );
  const date = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    [],
  );

  if (openId) {
    return (
      <Detail
        id={openId}
        organizationId={organizationId}
        canApprove={canApprove}
        canEdit={canApprove || canSubmit}
        readsCategories={readsCategories}
        onBack={() => {
          setOpenId(null);
          reloadList();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href="/inventory"
            className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:underline"
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('inventory.nav.title')}
          </Link>
          <h1 className="text-2xl font-semibold">{t('inventory.invoices.title')}</h1>
          <p className="text-muted-foreground">{t('inventory.invoices.intro')}</p>
        </div>
        {canSubmit && (
          <Button asChild>
            <Link href="/inventory/invoice" data-testid="queue-import">
              <FileText aria-hidden />
              {t('inventory.invoice.open')}
            </Link>
          </Button>
        )}
      </div>
      <div
        role="tablist"
        aria-label={t('inventory.invoices.status')}
        className="flex flex-wrap gap-2"
      >
        {TABS.map((status) => (
          <Button
            key={status}
            role="tab"
            aria-selected={tab === status}
            variant={tab === status ? 'default' : 'outline'}
            onClick={() => setTab(status)}
            data-testid={`queue-tab-${status}`}
          >
            {t(`inventory.invoices.statuses.${status}`)}
          </Button>
        ))}
      </div>
      <Loaded resource={list} reload={reloadList}>
        {(invoices) =>
          invoices.length === 0 ? (
            <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <Inbox aria-hidden className="size-8 text-muted-foreground" />
              <p className="text-muted-foreground">{t(`inventory.invoices.empty.${tab}`)}</p>
            </Card>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2" data-testid="queue-list">
              {invoices.map((invoice) => (
                <li key={invoice.id}>
                  <QueueCard
                    invoice={invoice}
                    onOpen={() => setOpenId(invoice.id)}
                    money={money}
                    when={date.format(new Date(invoice.createdAt))}
                  />
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}

function QueueCard({
  invoice,
  onOpen,
  money,
  when,
}: {
  invoice: VendorInvoiceSummary;
  onOpen: () => void;
  money: (amount: string) => string;
  when: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      data-testid="queue-item"
      data-number={invoice.number}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {invoice.supplier ?? t('inventory.invoices.noSupplier')}
        </span>
        <StatusBadge status={invoice.status} />
      </span>
      <span className="text-sm text-muted-foreground">
        {[invoice.number, invoice.invoiceNumber, invoice.invoiceDate].filter(Boolean).join(' · ')}
      </span>
      <span className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          {t('inventory.invoices.lines', {
            count: String(invoice.lineCount),
            fresh: String(invoice.newItemCount),
          })}
          {' · '}
          {invoice.warehouseName}
        </span>
        <span className="font-semibold tabular-nums">{money(invoice.total)}</span>
      </span>
      <span className="text-xs text-muted-foreground">
        {t('inventory.invoices.submittedBy', {
          name: invoice.submittedByName ?? '–',
          when,
        })}
      </span>
    </button>
  );
}

function StatusBadge({ status }: { status: VendorInvoiceStatus }) {
  const t = useT();
  return (
    <Badge
      className={cn(
        status === 'pending' && 'bg-accent text-accent-foreground',
        status === 'approved' && 'bg-primary text-primary-foreground',
      )}
      data-testid="queue-status"
    >
      {t(`inventory.invoices.statuses.${status}`)}
    </Badge>
  );
}

function Detail({
  id,
  organizationId,
  canApprove,
  canEdit,
  readsCategories,
  onBack,
}: {
  id: string;
  organizationId: string | null;
  canApprove: boolean;
  /** Approvers and those who receive goods may correct a pending one (the api lets the sender and approvers). */
  canEdit: boolean;
  readsCategories: boolean;
  onBack: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const [invoice, reload] = useResource(id, () => loadInvoice(store, id));
  const [warehouses] = useResource(organizationId, () => loadWarehouses(store));
  const [items] = useResource(organizationId, () => loadStockItems(store));
  const [categories, reloadCategories] = useResource(readsCategories ? organizationId : null, () =>
    loadCategories(store),
  );
  const [units, reloadUnits] = useResource(organizationId, () => loadUnits(store));
  const { session } = useAuth();
  const permissions = new Set(session?.activePermissions ?? []);
  return (
    <div className="flex flex-col gap-4" data-testid="queue-detail">
      <Button variant="ghost" className="self-start" onClick={onBack} data-testid="queue-back">
        <ArrowLeft aria-hidden />
        {t('inventory.invoices.title')}
      </Button>
      <Loaded resource={invoice} reload={reload}>
        {(loaded) => (
          <Loaded resource={warehouses} reload={() => undefined}>
            {(warehouseList) => (
              <Loaded resource={items} reload={() => undefined}>
                {(itemList) => (
                  <InvoiceDetail
                    key={`${loaded.id}:${loaded.status}:${loaded.lines.map((l) => `${l.quantity}@${l.unitCost}`).join(',')}`}
                    invoice={loaded}
                    warehouses={warehouseList.filter(
                      (w) => (w.archivedAt === null && !w.isTransit) || w.id === loaded.warehouseId,
                    )}
                    items={itemList}
                    categories={categories.status === 'ready' ? categories.data : null}
                    units={units.status === 'ready' ? units.data : []}
                    canCreateCategory={
                      categories.status === 'ready' && permissions.has('catalog.products.create')
                    }
                    canCreateUnit={permissions.has('inventory.items.create')}
                    onCategoryCreated={reloadCategories}
                    onUnitCreated={reloadUnits}
                    canApprove={canApprove}
                    canEdit={canEdit}
                    onChanged={reload}
                  />
                )}
              </Loaded>
            )}
          </Loaded>
        )}
      </Loaded>
    </div>
  );
}

/**
 * An approved invoice's lines can be corrected by an approver (ADR 0078): what they hold is taken out at the average
 * cost and the corrected quantity comes in. Lines of new items can't be corrected yet, so they have no dialog.
 */
function CorrectionsPanel({
  invoice,
  onChanged,
}: {
  invoice: VendorInvoice;
  onChanged: () => void;
}) {
  const t = useT();
  return (
    <section className="flex flex-col gap-3 rounded-md border p-4" data-testid="queue-corrections">
      <h2 className="text-sm font-semibold">{t('inventory.invoices.correctionsHeading')}</h2>
      <p className="text-sm text-muted-foreground">{t('inventory.invoices.correctHint')}</p>
      <ul className="flex flex-col gap-2">
        {invoice.lines.map((line) => (
          <li key={line.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span>
              {line.itemName ?? line.description} · {line.quantity} × {line.unitCost}
            </span>
            {line.itemId && <CorrectLine invoice={invoice} line={line} onChanged={onChanged} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CorrectLine({
  invoice,
  line,
  onChanged,
}: {
  invoice: VendorInvoice;
  line: VendorInvoice['lines'][number];
  onChanged: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const valid =
    /^\d{1,10}(\.\d{1,3})?$/.test(quantity.trim()) &&
    /[1-9]/.test(quantity) &&
    /^\d{1,10}(\.\d{1,4})?$/.test(unitCost.trim()) &&
    reason.trim() !== '';
  return (
    <FormDialog
      trigger={t('inventory.invoices.correctLine')}
      triggerVariant="outline"
      testId={`queue-correct-${line.position}`}
      title={t('inventory.invoices.correctTitle', { line: String(line.position + 1) })}
      submitLabel={t('inventory.invoices.correctSubmit')}
      onOpen={() => {
        setQuantity(line.quantity);
        setUnitCost(line.unitCost);
        setReason('');
      }}
      submit={() =>
        valid
          ? correctInvoiceLine(store, action, invoice.id, line.id, {
              quantity: quantity.trim(),
              unitCost: unitCost.trim(),
              reason: reason.trim(),
            })
          : null
      }
      onDone={onChanged}
    >
      <Field id={`${id}-quantity`} label={t('inventory.invoices.correctedQuantity')} problem={null}>
        <Input
          id={`${id}-quantity`}
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          data-testid="queue-correct-quantity"
        />
      </Field>
      <Field id={`${id}-cost`} label={t('inventory.invoices.correctedUnitCost')} problem={null}>
        <Input
          id={`${id}-cost`}
          inputMode="decimal"
          value={unitCost}
          onChange={(e) => setUnitCost(e.target.value)}
          data-testid="queue-correct-cost"
        />
      </Field>
      <Field id={`${id}-reason`} label={t('inventory.invoices.correctReason')} problem={null}>
        <Input
          id={`${id}-reason`}
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="queue-correct-reason"
        />
      </Field>
    </FormDialog>
  );
}

function InvoiceDetail({
  invoice,
  warehouses,
  items,
  categories,
  units,
  canCreateCategory,
  canCreateUnit,
  onCategoryCreated,
  onUnitCreated,
  canApprove,
  canEdit,
  onChanged,
}: {
  invoice: VendorInvoice;
  warehouses: Warehouse[];
  items: StockItem[];
  categories: ProductCategory[] | null;
  units: UnitOfMeasure[];
  canCreateCategory: boolean;
  canCreateUnit: boolean;
  onCategoryCreated: () => void;
  onUnitCreated: () => void;
  canApprove: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const saveAction = useActionKey();
  const approveAction = useActionKey();
  const rejectAction = useActionKey();
  const initialHeader: InvoiceHeader = {
    supplier: invoice.supplier ?? '',
    invoiceNumber: invoice.invoiceNumber ?? '',
    invoiceDate: invoice.invoiceDate ?? '',
    note: invoice.note ?? '',
    warehouseId: invoice.warehouseId,
  };
  const [header, setHeader] = useState<InvoiceHeader>(initialHeader);
  const [rows, setRows] = useState<InvoiceRow[]>(() => rowsFromInvoice(invoice, items));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const pending = invoice.status === 'pending';
  const problems = rowProblems(rows, true);
  const blocked = problems.some((p) => p.length > 0) || !rows.some((r) => r.include);

  const save = () =>
    updateInvoice(
      store,
      saveAction,
      invoice.id,
      submitRequest({
        items,
        rows,
        warehouseId: header.warehouseId,
        supplier: header.supplier,
        note: header.note,
        invoice: {
          number: header.invoiceNumber.trim() || null,
          date: header.invoiceDate.trim() || null,
          total: invoice.printedTotal,
        },
        fileName: invoice.fileName,
        source: invoice.source,
      }),
    );

  async function saveOnly() {
    setError(null);
    const result = await save();
    if (result.ok) {
      setDirty(false);
      onChanged();
    } else setError(t(errorLabel(result.code)));
  }

  /** Unsaved corrections are saved first, then the invoice is approved as saved. */
  async function approve() {
    if (dirty) {
      const saved = await save();
      if (!saved.ok) return saved;
    }
    return approveInvoice(store, approveAction, invoice.id);
  }

  const newCount = invoice.lines.filter((l) => l.newItem).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{invoice.supplier ?? invoice.number}</h1>
        <StatusBadge status={invoice.status} />
      </div>
      <p className="text-sm text-muted-foreground" data-testid="queue-detail-meta">
        {[invoice.number, invoice.invoiceNumber, invoice.invoiceDate, invoice.fileName]
          .filter(Boolean)
          .join(' · ')}
        {' · '}
        {t('inventory.invoices.by', { name: invoice.submittedByName ?? '–' })}
      </p>
      {invoice.status === 'approved' && invoice.documentNumber && (
        <Notice
          tone="info"
          text={t('inventory.invoices.approvedAs', {
            number: invoice.documentNumber,
            name: invoice.decidedByName ?? '–',
          })}
        />
      )}
      {invoice.status === 'rejected' && (
        <Notice
          tone="error"
          text={t('inventory.invoices.rejectedBecause', {
            reason: invoice.rejectReason ?? '',
            name: invoice.decidedByName ?? '–',
          })}
        />
      )}
      {invoice.source === 'scan' && pending && (
        <p className="text-sm text-muted-foreground">{t('inventory.invoice.scannedHint')}</p>
      )}
      <InvoiceEditor
        header={header}
        onHeader={(patch) => {
          setHeader((h) => ({ ...h, ...patch }));
          setDirty(true);
        }}
        rows={rows}
        onRows={(next) => {
          setRows(next);
          setDirty(true);
        }}
        problems={pending ? problems : []}
        items={items}
        categories={categories}
        units={units}
        warehouses={warehouses}
        canCreate
        canCreateCategory={canCreateCategory}
        canCreateUnit={canCreateUnit}
        onCategoryCreated={onCategoryCreated}
        onUnitCreated={onUnitCreated}
        printedTotal={invoice.printedTotal}
        readOnly={!pending || !canEdit}
        actions={
          pending ? (
            <>
              {dirty && (
                <Button
                  variant="outline"
                  disabled={blocked}
                  onClick={() => void saveOnly()}
                  data-testid="queue-save"
                >
                  {t('inventory.invoices.save')}
                </Button>
              )}
              {canApprove && (
                <>
                  <FormDialog
                    trigger={t('inventory.invoices.reject')}
                    triggerVariant="outline"
                    testId="queue-reject"
                    title={t('inventory.invoices.rejectTitle', { number: invoice.number })}
                    submitLabel={t('inventory.invoices.reject')}
                    onOpen={() => setReason('')}
                    submit={() =>
                      reason.trim() === ''
                        ? null
                        : rejectInvoice(store, rejectAction, invoice.id, { reason: reason.trim() })
                    }
                    onDone={onChanged}
                  >
                    <Field
                      id={`${id}-reason`}
                      label={t('inventory.invoices.reason')}
                      problem={null}
                    >
                      <textarea
                        id={`${id}-reason`}
                        value={reason}
                        rows={3}
                        maxLength={500}
                        onChange={(e) => setReason(e.target.value)}
                        className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        data-testid="queue-reject-reason"
                      />
                    </Field>
                  </FormDialog>
                  <ConfirmAction
                    trigger={t('inventory.invoices.approve')}
                    title={t('inventory.invoices.approveTitle', { number: invoice.number })}
                    description={t(
                      newCount > 0
                        ? 'inventory.invoices.approveWithNew'
                        : 'inventory.invoices.approveDescription',
                      {
                        count: String(rows.filter((r) => r.include).length),
                        fresh: String(newCount),
                      },
                    )}
                    confirm={t('inventory.invoices.approve')}
                    run={approve}
                    onDone={onChanged}
                    testId="queue-approve"
                    variant="default"
                  />
                </>
              )}
            </>
          ) : null
        }
      />
      {invoice.status === 'approved' && canApprove && (
        <CorrectionsPanel invoice={invoice} onChanged={onChanged} />
      )}
      {pending && rows.some((r) => r.include && r.target === NEW_ITEM) && (
        <p className="text-sm text-muted-foreground">{t('inventory.invoices.newItemsHint')}</p>
      )}
      <Notice text={error} tone="error" />
    </div>
  );
}
