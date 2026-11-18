'use client';

import type {
  ProductCategory,
  StockItem,
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
import { loadStockItems, loadWarehouses } from '../../lib/inventory/api';
import { submitInvoice } from '../../lib/inventory/invoices-api';
import {
  InvoicePdfError,
  parseInvoice,
  type ParsedInvoice,
  pdfRows,
  scanRows,
} from '../../lib/inventory/invoice-pdf';
import {
  type InvoiceRow,
  matchInvoice,
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
 * /inventory/invoice (docs/modules/inventory.md → Vendor invoices, ADR 0049, 0051): choose the supplier's PDF, or
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
      />
    </MoneyProvider>
  );
}

type Step =
  | { kind: 'choose'; problem: string | null; reading: string | null }
  | { kind: 'review'; fileName: string; source: VendorInvoiceSource; invoice: ParsedInvoice }
  | { kind: 'done'; invoice: VendorInvoice };

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function InvoiceImport({
  organizationId,
  readsCategories,
}: {
  organizationId: string | null;
  readsCategories: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [warehouses] = useResource(organizationId, () => loadWarehouses(store));
  const [items, reloadItems] = useResource(organizationId, () => loadStockItems(store));
  const [categories] = useResource(readsCategories ? organizationId : null, () =>
    loadCategories(store),
  );
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
}: {
  warehouses: Warehouse[];
  items: StockItem[];
  categories: ProductCategory[] | null;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [step, setStep] = useState<Step>({ kind: 'choose', problem: null, reading: null });
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [header, setHeader] = useState<InvoiceHeader>({
    supplier: '',
    note: '',
    warehouseId: warehouses[0]?.id ?? '',
    newItemUnit: 'pc',
    newItemCategoryId: '',
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
    setRows(matchInvoice(invoice.lines, items));
    setHeader((h) => ({
      ...h,
      supplier: invoice.supplier ?? '',
      note: invoice.number
        ? t('inventory.invoice.notePrefill', {
            number: invoice.number,
            date: invoice.date ?? '',
          }).trim()
        : '',
    }));
    setError(null);
    const fileName =
      files.length === 1
        ? files[0]!.name
        : t('inventory.invoice.photos', { count: String(files.length) });
    setStep({ kind: 'review', fileName, source, invoice });
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

  // Anyone who receives goods may propose new items: the approver creates them (ADR 0051).
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
        rows,
        warehouseId: header.warehouseId,
        supplier: header.supplier,
        note: header.note,
        invoice: review.invoice,
        fileName: review.fileName,
        source: review.source,
        newItemUnit: header.newItemUnit,
        newItemCategoryId: header.newItemCategoryId || null,
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
      <InvoiceEditor
        header={header}
        onHeader={(patch) => setHeader((h) => ({ ...h, ...patch }))}
        rows={rows}
        onRows={setRows}
        problems={problems}
        items={items}
        categories={categories}
        warehouses={warehouses}
        canCreate
        printedTotal={step.invoice.total}
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
    </div>
  );
}
