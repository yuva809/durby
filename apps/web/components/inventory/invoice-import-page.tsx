'use client';

import {
  STOCK_UNITS,
  type ProductCategory,
  type StockDocument,
  type StockItem,
  type StockUnit,
  type Warehouse,
} from '@durby/shared';
import { ArrowLeft, CheckCircle2, FileText, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories } from '../../lib/catalog/api';
import { importReceipt, loadStockItems, loadWarehouses } from '../../lib/inventory/api';
import { lineValue, sumValues } from '../../lib/inventory/format';
import { categoryPath } from '../../lib/inventory/overview';
import {
  InvoicePdfError,
  linesTotal,
  parseInvoice,
  type ParsedInvoice,
  pdfRows,
} from '../../lib/inventory/invoice-pdf';
import {
  type InvoiceRow,
  matchInvoice,
  NEW_ITEM,
  receiptRequest,
  rowProblems,
} from '../../lib/inventory/invoice-receipt';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { MoneyProvider, useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';

/**
 * /inventory/invoice (docs/modules/inventory.md → Vendor invoices, ADR 0049): choose the supplier's PDF; the browser
 * reads its item table; check each line (matched item or new, quantity, cost), then import it as one goods receipt.
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
        canCreate={permissions.has('inventory.items.edit')}
        readsCategories={
          session.activeFeatures.includes('catalog') && permissions.has('catalog.products.read')
        }
      />
    </MoneyProvider>
  );
}

type Step =
  | { kind: 'choose'; problem: string | null; reading: boolean }
  | { kind: 'review'; fileName: string; invoice: ParsedInvoice }
  | { kind: 'done'; document: StockDocument };

function InvoiceImport({
  organizationId,
  canCreate,
  readsCategories,
}: {
  organizationId: string | null;
  canCreate: boolean;
  readsCategories: boolean;
}) {
  const t = useT();
  const { store } = useAuth();
  const [warehouses] = useResource(organizationId, () => loadWarehouses(store));
  const [items, reloadItems] = useResource(organizationId, () => loadStockItems(store));
  const [categories] = useResource(readsCategories ? organizationId : null, () =>
    loadCategories(store),
  );
  const [step, setStep] = useState<Step>({ kind: 'choose', problem: null, reading: false });

  async function read(
    file: File | undefined,
    itemList: StockItem[],
    onRead: (rows: InvoiceRow[], invoice: ParsedInvoice) => void,
  ) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setStep({ kind: 'choose', problem: t('inventory.invoice.notPdf'), reading: false });
      return;
    }
    setStep({ kind: 'choose', problem: null, reading: true });
    try {
      const invoice = parseInvoice(await pdfRows(file));
      if (invoice.lines.length === 0) {
        setStep({ kind: 'choose', problem: t('inventory.invoice.noLines'), reading: false });
        return;
      }
      onRead(matchInvoice(invoice.lines, itemList), invoice);
      setStep({ kind: 'review', fileName: file.name, invoice });
    } catch (error) {
      const reason = error instanceof InvoicePdfError ? error.reason : 'unreadable';
      setStep({
        kind: 'choose',
        problem: t(`inventory.invoice.problems.${reason}`),
        reading: false,
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
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
      <Loaded resource={warehouses} reload={() => undefined}>
        {(warehouseList) => (
          <Loaded resource={items} reload={reloadItems}>
            {(itemList) => (
              <Review
                step={step}
                warehouses={warehouseList.filter((w) => w.archivedAt === null && !w.isTransit)}
                items={itemList}
                categories={categories.status === 'ready' ? categories.data : null}
                canCreate={canCreate}
                onFile={(file, onRead) => void read(file, itemList, onRead)}
                onDone={(document) => {
                  reloadItems();
                  setStep({ kind: 'done', document });
                }}
                onAgain={() => setStep({ kind: 'choose', problem: null, reading: false })}
              />
            )}
          </Loaded>
        )}
      </Loaded>
    </div>
  );
}

function Review({
  step,
  warehouses,
  items,
  categories,
  canCreate,
  onFile,
  onDone,
  onAgain,
}: {
  step: Step;
  warehouses: Warehouse[];
  items: StockItem[];
  categories: ProductCategory[] | null;
  canCreate: boolean;
  onFile: (
    file: File | undefined,
    onRead: (rows: InvoiceRow[], invoice: ParsedInvoice) => void,
  ) => void;
  onDone: (document: StockDocument) => void;
  onAgain: () => void;
}) {
  const t = useT();
  const id = useId();
  const money = useMoney();
  const { store } = useAuth();
  const action = useActionKey();
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [unit, setUnit] = useState<StockUnit>('pc');
  const [categoryId, setCategoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (step.kind === 'done') {
    return (
      <Card className="flex flex-col items-start gap-3 p-6" data-testid="invoice-done">
        <CheckCircle2 aria-hidden className="size-8 text-primary" />
        <p className="font-medium">
          {t('inventory.invoice.done', {
            number: step.document.number,
            count: String(step.document.lineCount),
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/inventory">{t('inventory.nav.title')}</Link>
          </Button>
          <Button variant="outline" onClick={onAgain} data-testid="invoice-again">
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
          accept="application/pdf,.pdf"
          disabled={step.reading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            onFile(file, (next, invoice) => {
              // Prefilled from the PDF; the person may change them.
              setRows(next);
              setSupplier(invoice.supplier ?? '');
              setNote(
                invoice.number
                  ? t('inventory.invoice.notePrefill', {
                      number: invoice.number,
                      date: invoice.date ?? '',
                    }).trim()
                  : '',
              );
              setError(null);
            });
          }}
          className="text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:bg-card file:px-4 file:font-medium"
          data-testid="invoice-file"
        />
        <p className="text-sm text-muted-foreground">{t('inventory.invoice.fileHint')}</p>
        {step.reading && (
          <p role="status" className="text-sm" data-testid="invoice-reading">
            {t('inventory.invoice.reading')}
          </p>
        )}
        <Notice text={step.problem} tone="error" />
      </Card>
    );
  }

  const { invoice } = step;
  const problems = rowProblems(rows, canCreate);
  const included = rows.filter((r) => r.include);
  const blocked = problems.some((p) => p.length > 0) || included.length === 0 || !warehouseId;
  const values = included.map(
    (r) => lineValue(r.quantity.replace(',', '.'), r.unitCost.replace(',', '.')) ?? '0',
  );
  const total = sumValues(values);
  const printed = invoice.total;
  const newCount = included.filter((r) => r.target === NEW_ITEM).length;
  const sortedItems = [...items]
    .filter((i) => i.archivedAt === null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const update = (index: number, patch: Partial<InvoiceRow>) =>
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await importReceipt(
      store,
      action,
      receiptRequest({
        rows,
        warehouseId,
        supplier,
        note,
        newItemUnit: unit,
        newItemCategoryId: categoryId || null,
      }),
    );
    setBusy(false);
    if (result.ok && result.data) onDone(result.data);
    else if (!result.ok) setError(t(errorLabel(result.code)));
  }

  return (
    <div className="flex flex-col gap-4" data-testid="invoice-review">
      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-supplier`}>{t('inventory.invoice.supplier')}</Label>
          <Input
            id={`${id}-supplier`}
            value={supplier}
            placeholder={t('inventory.invoice.supplierPlaceholder')}
            maxLength={100}
            onChange={(e) => setSupplier(e.target.value)}
            data-testid="invoice-supplier"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-note`}>{t('inventory.invoice.note')}</Label>
          <Input
            id={`${id}-note`}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            data-testid="invoice-note"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-warehouse`}>{t('inventory.fields.warehouse')}</Label>
          <Select
            id={`${id}-warehouse`}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            data-testid="invoice-warehouse"
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        {newCount > 0 && (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-unit`}>{t('inventory.invoice.newUnit')}</Label>
              <Select
                id={`${id}-unit`}
                value={unit}
                onChange={(e) => setUnit(e.target.value as StockUnit)}
                data-testid="invoice-new-unit"
              >
                {STOCK_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {t(`inventory.units.${u}`)}
                  </option>
                ))}
              </Select>
            </div>
            {categories && (
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-category`}>{t('inventory.invoice.newCategory')}</Label>
                <Select
                  id={`${id}-category`}
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  data-testid="invoice-new-category"
                >
                  <option value="">{t('inventory.page.uncategorized')}</option>
                  {categories
                    .filter((c) => c.archivedAt === null)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {categoryPath(categories, c.id)}
                      </option>
                    ))}
                </Select>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FileText aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-medium">{step.fileName}</span>
        <span className="text-muted-foreground">
          {t('inventory.invoice.summary', {
            lines: String(rows.length),
            matched: String(included.length - newCount),
            fresh: String(newCount),
          })}
        </span>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[52rem] text-sm" data-testid="invoice-lines">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2">
                <span className="sr-only">{t('inventory.invoice.include')}</span>
              </th>
              <th className="px-3 py-2 font-medium">{t('inventory.invoice.line')}</th>
              <th className="px-3 py-2 font-medium">{t('inventory.fields.item')}</th>
              <th className="w-28 px-3 py-2 text-right font-medium">
                {t('inventory.fields.quantity')}
              </th>
              <th className="w-32 px-3 py-2 text-right font-medium">
                {t('inventory.invoice.unitCost')}
              </th>
              <th className="w-28 px-3 py-2 text-right font-medium">
                {t('inventory.fields.value')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, index) => {
              const rowProblemsList = problems[index] ?? [];
              const value = lineValue(
                row.quantity.replace(',', '.'),
                row.unitCost.replace(',', '.'),
              );
              return (
                <tr
                  key={index}
                  className={cn(!row.include && 'opacity-50')}
                  data-testid="invoice-line"
                  data-code={row.line.code ?? ''}
                >
                  <td className="px-3 py-2 align-top">
                    <Checkbox
                      checked={row.include}
                      onCheckedChange={(next) => update(index, { include: next === true })}
                      aria-label={t('inventory.invoice.includeLine', {
                        name: row.line.description,
                      })}
                      data-testid="invoice-line-include"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{row.line.description}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {row.line.code}
                        {!row.line.checks && (
                          <Badge
                            className="bg-accent text-accent-foreground"
                            data-testid="invoice-line-check"
                          >
                            <TriangleAlert aria-hidden className="size-3" />
                            {t('inventory.invoice.checkLine')}
                          </Badge>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Select
                      value={row.target}
                      onChange={(e) => update(index, { target: e.target.value })}
                      aria-label={t('inventory.invoice.itemFor', { name: row.line.description })}
                      data-testid="invoice-line-item"
                    >
                      <option value={NEW_ITEM} disabled={!canCreate}>
                        {t('inventory.invoice.newItem')}
                      </option>
                      {sortedItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.sku ? `${item.name} · ${item.sku}` : item.name}
                        </option>
                      ))}
                    </Select>
                    {row.include && row.target === NEW_ITEM && canCreate && (
                      <Badge className="mt-1" data-testid="invoice-line-new">
                        {t('inventory.invoice.newBadge')}
                      </Badge>
                    )}
                    {rowProblemsList
                      .filter((p) => p === 'duplicate' || p === 'newNotAllowed')
                      .map((p) => (
                        <p
                          key={p}
                          className="mt-1 text-xs text-destructive"
                          data-testid="invoice-line-problem"
                        >
                          {t(`inventory.invoice.rowProblems.${p}`)}
                        </p>
                      ))}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Input
                      inputMode="decimal"
                      className="text-right"
                      value={row.quantity}
                      aria-label={t('inventory.fields.quantity')}
                      aria-invalid={rowProblemsList.includes('quantity') || undefined}
                      onChange={(e) => update(index, { quantity: e.target.value })}
                      data-testid="invoice-line-quantity"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Input
                      inputMode="decimal"
                      className="text-right"
                      value={row.unitCost}
                      aria-label={t('inventory.invoice.unitCost')}
                      aria-invalid={rowProblemsList.includes('unitCost') || undefined}
                      onChange={(e) => update(index, { unitCost: e.target.value })}
                      data-testid="invoice-line-cost"
                    />
                  </td>
                  <td className="px-3 py-2 text-right align-top font-medium tabular-nums">
                    {value ? money(value) : '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-col gap-1">
          <p className="text-lg font-semibold tabular-nums" data-testid="invoice-total">
            {t('inventory.invoice.total', { amount: money(total) })}
          </p>
          {printed && (
            <p
              className={cn(
                'text-sm',
                total === printed ? 'text-muted-foreground' : 'text-destructive',
              )}
              data-testid="invoice-total-check"
            >
              {total === printed
                ? t('inventory.invoice.totalMatches', { amount: money(printed) })
                : t('inventory.invoice.totalDiffers', {
                    amount: money(printed),
                    lines: money(linesTotal(invoice.lines)),
                  })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onAgain}>
            {t('inventory.invoice.other')}
          </Button>
          <Button
            disabled={blocked || busy}
            onClick={() => void submit()}
            data-testid="invoice-import"
          >
            {t('inventory.invoice.import', { count: String(included.length) })}
          </Button>
        </div>
      </Card>
      <Notice text={error} tone="error" />
    </div>
  );
}
