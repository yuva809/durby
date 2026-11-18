'use client';

import type {
  ProductCategory,
  StockItem,
  UnitOfMeasure,
  VendorInvoice,
  VendorInvoiceSource,
  Warehouse,
} from '@durby/shared';
import { ArrowLeft, CheckCircle2, FileText, ListChecks } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories } from '../../lib/catalog/api';
import { loadStockItems, loadUnits, loadWarehouses } from '../../lib/inventory/api';
import { submitInvoice } from '../../lib/inventory/invoices-api';
import {
  InvoicePdfError,
  parseInvoice,
  type ParsedInvoice,
  pdfRows,
  scanRows,
} from '../../lib/inventory/invoice-pdf';
import {
  type CountAs,
  type InvoiceRow,
  matchInvoice,
  recount,
  rowProblems,
  submitRequest,
} from '../../lib/inventory/invoice-receipt';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { MoneyProvider } from '../pos/money';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Label } from '../ui/label';
import { Loaded, NoAccess } from '../users/common';
import { type InvoiceHeader, InvoiceEditor } from './invoice-editor';

/**
 * /inventory/invoice (docs/modules/inventory.md → Vendor invoices, ADR 0049, 0054): choose the supplier's PDF, or
 * photos of it; it is read on this device (a PDF's own text, else on-device recognition); check each line, then send
 * it for approval. Nothing is in stock until someone approves it in the queue (/inventory/invoices).
 */
export function InvoiceImportPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (
    !session.activeFeatures.includes('inventory') ||
    !permissions.has('inventory.stock.receive')
  ) {
    return <NoAccess title="inventory.invoice.title" />;
  }
  return (
    <MoneyProvider>
      <InvoiceImport
        organizationId={session.activeOrganizationId}
        readsCategories={
          session.activeFeatures.includes('catalog') && permissions.has('catalog.products.read')
        }
        canCreateCategory={
          session.activeFeatures.includes('catalog') && permissions.has('catalog.products.create')
        }
        canCreateUnit={permissions.has('inventory.items.create')}
      />
    </MoneyProvider>
  );
}

type Step =
  | { kind: 'choose'; problem: string | null; reading: string | null }
  | {
      kind: 'review';
      fileName: string;
      source: VendorInvoiceSource;
      invoice: ParsedInvoice;
      /** The text rows read from the pages, for "Show what was read". */
      read: string[];
    }
  | { kind: 'done'; invoice: VendorInvoice };

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function InvoiceImport({
  organizationId,
  readsCategories,
  canCreateCategory,
  canCreateUnit,
}: {
  organizationId: string | null;
  readsCategories: boolean;
  canCreateCategory: boolean;
  canCreateUnit: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [warehouses] = useResource(organizationId, () => loadWarehouses(store));
  const [items, reloadItems] = useResource(organizationId, () => loadStockItems(store));
  const [categories, reloadCategories] = useResource(readsCategories ? organizationId : null, () =>
    loadCategories(store),
  );
  const [units, reloadUnits] = useResource(organizationId, () => loadUnits(store));
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
          <h1 className="text-2xl font-semibold">{t('inventory.invoice.title')}</h1>
          <p className="text-muted-foreground">{t('inventory.invoice.intro')}</p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/inventory/invoices" data-testid="invoice-queue-link">
            <ListChecks aria-hidden />
            {t('inventory.invoices.title')}
          </Link>
        </Button>
      </div>
      <Loaded resource={warehouses} reload={() => undefined}>
        {(warehouseList) => (
          <Loaded resource={items} reload={reloadItems}>
            {(itemList) => (
              <Flow
                warehouses={warehouseList.filter((w) => w.archivedAt === null && !w.isTransit)}
                items={itemList}
                categories={categories.status === 'ready' ? categories.data : null}
                units={units.status === 'ready' ? units.data : []}
                canCreateCategory={canCreateCategory && categories.status === 'ready'}
                canCreateUnit={canCreateUnit}
                onCategoryCreated={reloadCategories}
                onUnitCreated={reloadUnits}
              />
            )}
          </Loaded>
        )}
      </Loaded>
    </div>
  );
}

function Flow({
  warehouses,
  items,
  categories,
  units,
  canCreateCategory,
  canCreateUnit,
  onCategoryCreated,
  onUnitCreated,
}: {
  warehouses: Warehouse[];
  items: StockItem[];
  categories: ProductCategory[] | null;
  units: UnitOfMeasure[];
  canCreateCategory: boolean;
  canCreateUnit: boolean;
  onCategoryCreated: () => void;
  onUnitCreated: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [step, setStep] = useState<Step>({ kind: 'choose', problem: null, reading: null });
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  // Packed lines as invoiced (the packs) or by the piece (ADR 0058).
  const [countAs, setCountAs] = useState<CountAs>('invoiced');
  const [header, setHeader] = useState<InvoiceHeader>({
    supplier: '',
    invoiceNumber: '',
    invoiceDate: '',
    note: '',
    warehouseId: warehouses[0]?.id ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read(files: File[]) {
    if (files.length === 0) return;
    const choose = (problem: string | null, reading: string | null = null) =>
      setStep({ kind: 'choose', problem, reading });
    const supported = files.every(
      (f) => isPdf(f) || f.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(f.name),
    );
    if (!supported || (files.length > 1 && files.some(isPdf))) {
      choose(t('inventory.invoice.notPdf'));
      return;
    }
    choose(null, t('inventory.invoice.reading'));
    let source: VendorInvoiceSource = 'pdf';
    let rowsRead: string[];
    try {
      try {
        if (!isPdf(files[0]!)) throw new InvoicePdfError('noText');
        rowsRead = await pdfRows(files[0]!);
      } catch (error) {
        if (!(error instanceof InvoicePdfError && error.reason === 'noText')) throw error;
        // A photo, or a scanned PDF: read on the device, more slowly and less exactly.
        source = 'scan';
        rowsRead = await scanRows(files, (share) =>
          choose(
            null,
            t('inventory.invoice.scanning', { percent: String(Math.round(share * 100)) }),
          ),
        );
      }
    } catch (error) {
      const reason = error instanceof InvoicePdfError ? error.reason : 'unreadable';
      choose(t(`inventory.invoice.problems.${reason}`));
      return;
    }
    const invoice = parseInvoice(rowsRead);
    if (invoice.lines.length === 0) {
      choose(t('inventory.invoice.noLines'));
      return;
    }
    setCountAs('invoiced');
    setRows(matchInvoice(invoice.lines, items));
    setHeader((h) => ({
      ...h,
      supplier: invoice.supplier ?? '',
      invoiceNumber: invoice.number ?? '',
      invoiceDate: invoice.date ?? '',
      note: '',
    }));
    setError(null);
    const fileName =
      files.length === 1
        ? files[0]!.name
        : t('inventory.invoice.photos', { count: String(files.length) });
    setStep({ kind: 'review', fileName, source, invoice, read: rowsRead });
  }

  if (step.kind === 'done') {
    return (
      <Card className="flex flex-col items-start gap-3 p-6" data-testid="invoice-done">
        <CheckCircle2 aria-hidden className="size-8 text-primary" />
        <p className="font-medium">
          {t('inventory.invoice.sent', {
            number: step.invoice.number,
            count: String(step.invoice.lineCount),
          })}
        </p>
        <p className="text-sm text-muted-foreground">{t('inventory.invoice.sentHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/inventory/invoices?open=${step.invoice.id}`}>
              {t('inventory.invoices.title')}
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => setStep({ kind: 'choose', problem: null, reading: null })}
            data-testid="invoice-again"
          >
            {t('inventory.invoice.again')}
          </Button>
        </div>
      </Card>
    );
  }

  if (step.kind === 'choose') {
    return (
      <Card className="flex flex-col gap-3 p-6">
        <Label htmlFor={`${id}-file`}>{t('inventory.invoice.file')}</Label>
        <input
          id={`${id}-file`}
          type="file"
          multiple
          accept="application/pdf,.pdf,image/jpeg,image/png,image/webp"
          disabled={step.reading !== null}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void read(files);
          }}
          className="text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:bg-card file:px-4 file:font-medium"
          data-testid="invoice-file"
        />
        <p className="text-sm text-muted-foreground">{t('inventory.invoice.fileHint')}</p>
        {step.reading && (
          <p role="status" className="text-sm" data-testid="invoice-reading">
            {step.reading}
          </p>
        )}
        <Notice text={step.problem} tone="error" />
      </Card>
    );
  }

  // Anyone who receives goods may propose new items: the approver creates them (ADR 0054).
  const problems = rowProblems(rows, true);
  const included = rows.filter((r) => r.include);
  const blocked =
    problems.some((p) => p.length > 0) || included.length === 0 || !header.warehouseId;

  async function submit(review: Extract<Step, { kind: 'review' }>) {
    setBusy(true);
    setError(null);
    const result = await submitInvoice(
      store,
      action,
      submitRequest({
        items,
        rows,
        warehouseId: header.warehouseId,
        supplier: header.supplier,
        note: header.note,
        // As read, or as corrected in the header.
        invoice: {
          number: header.invoiceNumber.trim() || null,
          date: header.invoiceDate.trim() || null,
          total: review.invoice.total,
        },
        fileName: review.fileName,
        source: review.source,
      }),
    );
    setBusy(false);
    if (result.ok && result.data) setStep({ kind: 'done', invoice: result.data });
    else if (!result.ok) setError(t(errorLabel(result.code)));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FileText aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-medium">{step.fileName}</span>
        {step.source === 'scan' && (
          <span className="text-muted-foreground" data-testid="invoice-scanned">
            {t('inventory.invoice.scannedHint')}
          </span>
        )}
      </div>
      {step.invoice.lines.some((l) => l.pack) && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3"
          data-testid="invoice-count-as"
        >
          <span className="text-sm font-medium">{t('inventory.invoice.countAs')}</span>
          <div className="flex gap-1" role="radiogroup" aria-label={t('inventory.invoice.countAs')}>
            {(['invoiced', 'pieces'] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                role="radio"
                aria-checked={countAs === mode}
                variant={countAs === mode ? 'default' : 'outline'}
                className="rounded-full"
                onClick={() => {
                  if (mode === countAs) return;
                  setCountAs(mode);
                  setRows((current) => recount(current, mode));
                }}
                data-testid={`invoice-count-${mode}`}
              >
                {t(
                  mode === 'invoiced'
                    ? 'inventory.invoice.countInvoiced'
                    : 'inventory.invoice.countPieces',
                )}
              </Button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {t('inventory.invoice.countAsHint')}
          </span>
        </div>
      )}
      <InvoiceEditor
        header={header}
        onHeader={(patch) => setHeader((h) => ({ ...h, ...patch }))}
        rows={rows}
        onRows={setRows}
        problems={problems}
        items={items}
        categories={categories}
        units={units}
        warehouses={warehouses}
        canCreate
        canCreateCategory={canCreateCategory}
        canCreateUnit={canCreateUnit}
        onCategoryCreated={onCategoryCreated}
        onUnitCreated={onUnitCreated}
        printedTotal={step.invoice.total}
        skipped={step.invoice.skipped}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setStep({ kind: 'choose', problem: null, reading: null })}
            >
              {t('inventory.invoice.other')}
            </Button>
            <Button
              disabled={blocked || busy}
              onClick={() => void submit(step)}
              data-testid="invoice-submit"
            >
              {t('inventory.invoice.submit', { count: String(included.length) })}
            </Button>
          </>
        }
      />
      <Notice text={error} tone="error" />
      <details className="rounded-lg border bg-card p-3 text-sm" data-testid="invoice-read">
        <summary className="cursor-pointer font-medium">{t('inventory.invoice.showRead')}</summary>
        <pre className="mt-2 max-h-80 overflow-auto text-xs whitespace-pre-wrap text-muted-foreground">
          {step.read.join('\n')}
        </pre>
      </details>
    </div>
  );
}
