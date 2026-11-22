'use client';

import {
  checkCategoryRows,
  checkCustomerRows,
  checkItemRows,
  checkOpeningStockRows,
  type CategoryImportRow,
  type CustomerImportRow,
  type DataImportProblemRow,
  type DataImportResult,
  type FeatureKey,
  IMPORT_KINDS,
  IMPORT_REQUIRED_COLUMNS,
  IMPORT_TEMPLATES,
  type ImportKind,
  type ItemImportRow,
  type OpeningStockImportRow,
  type PermissionKey,
  STOCK_UNITS,
  type StockUnit,
} from '@durby/shared';
import {
  ArrowRight,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileUp,
  FolderTree,
  ListChecks,
  type LucideIcon,
  Package,
  ReceiptText,
  Upload,
  Users,
  Warehouse,
} from 'lucide-react';
import Link from 'next/link';
import { type ChangeEvent, type ReactNode, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { runImport } from '../../lib/imports/api';
import {
  isExcel,
  readRows,
  readXlsxRows,
  type ReadRows,
  type TableProblem,
  templateCsv,
  withUnitCodes,
} from '../../lib/imports/table';
import { loadStockItems, loadWarehouses } from '../../lib/inventory/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { NoAccess } from '../users/common';

/** Who may import what: the key of the module that owns the records (the api checks the same). */
const ACCESS: Readonly<Record<ImportKind, { feature: FeatureKey; permission: PermissionKey }>> = {
  categories: { feature: 'catalog', permission: 'catalog.products.create' },
  items: { feature: 'inventory', permission: 'inventory.items.create' },
  opening_stock: { feature: 'inventory', permission: 'inventory.stock.receive' },
  customers: { feature: 'orders', permission: 'orders.customers.create' },
};

const ICONS: Readonly<Record<ImportKind, LucideIcon>> = {
  categories: FolderTree,
  items: Package,
  opening_stock: Warehouse,
  customers: Users,
};

/** `opening_stock` → `openingStock`: label keys are camelCase. */
const labelKey = <T extends string>(value: T) =>
  value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as T extends `${infer A}_${infer B}`
    ? `${A}${Capitalize<B>}`
    : T;

const isStockUnit = (value: string): value is StockUnit =>
  (STOCK_UNITS as readonly string[]).includes(value);

const PREVIEW_ROWS = 10;
const PROBLEM_ROWS = 50;
const ACCEPT =
  '.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * /import, Import Data (docs/platform/import.md, ADR 0044 step 4, ADR 0054): pick what to import, download its
 * template, choose a CSV or Excel file, check the preview and its problems, then import all rows at once (all or
 * nothing). A supplier's invoice is a PDF or photos, not a table: its tile leads to its own page and the approval queue.
 */
export function ImportPage() {
  const { session } = useAuth();
  if (!session) return null;
  const kinds = IMPORT_KINDS.filter(
    (kind) =>
      session.activeFeatures.includes(ACCESS[kind].feature) &&
      session.activePermissions.includes(ACCESS[kind].permission),
  );
  const inventory = session.activeFeatures.includes('inventory');
  const invoices = {
    submit: inventory && session.activePermissions.includes('inventory.stock.receive'),
    queue: inventory && session.activePermissions.includes('inventory.stock.read'),
  };
  if (kinds.length === 0 && !invoices.submit) return <NoAccess title="platform.nav.importData" />;
  return (
    <Importer kinds={kinds} invoices={invoices} organizationId={session.activeOrganizationId} />
  );
}

type State =
  | { step: 'choose'; problem: TableProblem | null; reading: boolean }
  | { step: 'preview'; fileName: string; rows: Record<string, string>[] }
  | { step: 'done'; result: DataImportResult };

const CHOOSE: State = { step: 'choose', problem: null, reading: false };

function Importer({
  kinds,
  invoices,
  organizationId,
}: {
  kinds: ImportKind[];
  invoices: { submit: boolean; queue: boolean };
  organizationId: string | null;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [kind, setKind] = useState<ImportKind | null>(kinds[0] ?? null);
  const [state, setState] = useState<State>(CHOOSE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opening stock names warehouses and items: the preview checks them against what exists.
  const needsRefs = kind === 'opening_stock' && organizationId !== null;
  const [warehouses] = useResource(needsRefs ? organizationId : null, () => loadWarehouses(store));
  const [items] = useResource(needsRefs ? organizationId : null, () => loadStockItems(store));

  const pick = (next: ImportKind) => {
    setKind(next);
    setState(CHOOSE);
    setError(null);
  };

  const problemsOf = (
    current: ImportKind,
    rows: Record<string, string>[],
  ): DataImportProblemRow[] => {
    switch (current) {
      case 'categories':
        return checkCategoryRows(rows as unknown as CategoryImportRow[]);
      case 'items':
        return checkItemRows(rows as unknown as ItemImportRow[]);
      case 'customers':
        return checkCustomerRows(rows as unknown as CustomerImportRow[]);
      case 'opening_stock': {
        const known =
          warehouses.status === 'ready' && items.status === 'ready'
            ? {
                warehouses: new Set(
                  warehouses.data.filter((w) => !w.archivedAt).map((w) => w.name.toLowerCase()),
                ),
                items: new Set(
                  items.data
                    .filter((i) => !i.archivedAt)
                    .flatMap((i) => [
                      i.name.toLowerCase(),
                      ...(i.sku ? [i.sku.toLowerCase()] : []),
                    ]),
                ),
              }
            : undefined;
        return checkOpeningStockRows(rows as unknown as OpeningStockImportRow[], known);
      }
    }
  };

  function downloadTemplate(current: ImportKind) {
    // CSV with a BOM: Excel opens it with the right characters, and saves back as .xlsx or .csv.
    const url = URL.createObjectURL(
      new Blob([String.fromCharCode(0xfeff), templateCsv(current)], { type: 'text/csv' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${current.replace('_', '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(current: ImportKind, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // The same file can be chosen again after fixing it.
    event.target.value = '';
    setError(null);
    if (!file) return;
    let read: ReadRows;
    if (isExcel(file.name)) {
      setState({ step: 'choose', problem: null, reading: true });
      read = await readXlsxRows(current, file);
    } else if (/\.(csv|txt)$/i.test(file.name) || file.type === 'text/csv') {
      read = readRows(current, await file.text());
    } else {
      read = { ok: false, problem: { kind: 'unreadable' } };
    }
    setState(
      read.ok
        ? {
            step: 'preview',
            fileName: file.name,
            rows:
              current === 'items'
                ? withUnitCodes(read.rows, (u) => t(`inventory.units.${u}`))
                : read.rows,
          }
        : { step: 'choose', problem: read.problem, reading: false },
    );
  }

  async function onImport(current: ImportKind, rows: Record<string, string>[]) {
    setBusy(true);
    setError(null);
    const result = await runImport(store, action, current, rows);
    setBusy(false);
    if (result.ok && result.data) setState({ step: 'done', result: result.data });
    else setError(t(errorLabel(result.ok ? 'unknown' : result.code)));
  }

  const tableProblem = (problem: TableProblem) => {
    switch (problem.kind) {
      case 'empty':
        return t('platform.importPage.empty');
      case 'unreadable':
        return t('platform.importPage.unreadable');
      case 'tooManyRows':
        return t('platform.importPage.tooManyRows', { max: String(problem.max) });
      case 'missingColumns':
        return t('platform.importPage.missingColumns', { columns: problem.columns.join(', ') });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Hero />

      <section className="flex flex-col gap-3" aria-labelledby={`${id}-what`}>
        <h2 id={`${id}-what`} className="text-lg font-semibold">
          {t('platform.importPage.what')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {kinds.length > 0 && (
            <div role="radiogroup" aria-labelledby={`${id}-what`} className="contents">
              {kinds.map((k) => (
                <Tile
                  key={k}
                  icon={ICONS[k]}
                  name={t(`platform.importPage.kinds.${labelKey(k)}.name`)}
                  description={t(`platform.importPage.kinds.${labelKey(k)}.description`)}
                  formats={t('platform.importPage.formats')}
                  selected={k === kind}
                  onSelect={() => pick(k)}
                  testId={`import-kind-${k}`}
                />
              ))}
            </div>
          )}
          {invoices.submit && <InvoiceTile queue={invoices.queue} />}
        </div>
      </section>

      {kind && (
        <Card className="flex flex-col gap-5 p-5" data-testid="import-work">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">
              {t(`platform.importPage.kinds.${labelKey(kind)}.name`)}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t(`platform.importPage.kinds.${labelKey(kind)}.rules`)}
            </p>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-sm font-medium">{t('platform.importPage.columns')}</span>
              <ul className="flex flex-wrap gap-1.5" data-testid="import-columns">
                {IMPORT_TEMPLATES[kind].map((c) => (
                  <li
                    key={c}
                    className={cn(
                      'rounded-md border px-2 py-0.5 font-mono text-xs',
                      IMPORT_REQUIRED_COLUMNS[kind].includes(c)
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : 'bg-muted text-muted-foreground',
                    )}
                    data-testid="import-column"
                  >
                    {c}
                  </li>
                ))}
              </ul>
              <span className="text-xs text-muted-foreground">
                {t('platform.importPage.requiredHint')}
              </span>
            </div>
            <Button
              variant="outline"
              onClick={() => downloadTemplate(kind)}
              data-testid="import-template"
            >
              <Download aria-hidden />
              {t('platform.importPage.template')}
            </Button>
          </div>

          <label
            htmlFor={`${id}-file`}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed bg-muted/40 px-4 py-8 text-center transition-colors hover:border-primary hover:bg-primary/5 focus-within:border-primary"
          >
            <FileSpreadsheet aria-hidden className="size-8 text-primary" />
            <span className="font-medium">{t('platform.importPage.file')}</span>
            <span className="text-sm text-muted-foreground">
              {t('platform.importPage.fileHint')}
            </span>
            <input
              id={`${id}-file`}
              type="file"
              accept={ACCEPT}
              disabled={state.step === 'choose' && state.reading}
              onChange={(e) => void onFile(kind, e)}
              className="sr-only"
              data-testid="import-file"
            />
          </label>
          {state.step === 'choose' && state.reading && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('platform.importPage.reading')}
            </p>
          )}
          {state.step === 'choose' && state.problem && (
            <Notice text={tableProblem(state.problem)} tone="error" />
          )}
        </Card>
      )}

      {kind && state.step === 'preview' && (
        <Preview
          columns={IMPORT_TEMPLATES[kind]}
          fileName={state.fileName}
          rows={state.rows}
          problems={problemsOf(kind, state.rows)}
          busy={busy}
          error={error}
          onImport={() => void onImport(kind, state.rows)}
          onCancel={() => setState(CHOOSE)}
        />
      )}

      {state.step === 'done' && (
        <Card className="flex flex-col gap-2 p-5" role="status" data-testid="import-done">
          <p className="flex items-center gap-2 font-medium">
            <CheckCircle2 aria-hidden className="size-5 text-primary" />
            {t('platform.importPage.done')}
          </p>
          <p className="text-sm">
            {t('platform.importPage.summary', {
              created: String(state.result.created),
              updated: String(state.result.updated),
              unchanged: String(state.result.unchanged),
            })}
          </p>
          {state.result.documents.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('platform.importPage.documents', { numbers: state.result.documents.join(', ') })}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

/** The page's header: what it is for, and the three steps. */
function Hero() {
  const t = useT();
  const steps = [
    t('platform.importPage.steps.template'),
    t('platform.importPage.steps.fill'),
    t('platform.importPage.steps.upload'),
  ];
  return (
    <div
      className="flex flex-col gap-5 rounded-2xl border bg-gradient-to-br from-primary/15 via-card to-card p-6"
      data-testid="import-hero"
    >
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Upload aria-hidden className="size-6" />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.importPage.heroTitle')}</h1>
          <p className="max-w-2xl text-muted-foreground">{t('platform.importPage.intro')}</p>
        </div>
      </div>
      <ol className="grid gap-2 sm:grid-cols-3">
        {steps.map((step, i) => (
          <li
            key={step}
            className="flex items-center gap-3 rounded-lg bg-card/80 px-3 py-2 text-sm shadow-xs"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

function TileBody({
  icon: Icon,
  name,
  description,
  formats,
  children,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  formats: string;
  children?: ReactNode;
}) {
  return (
    <>
      <span className="flex items-start justify-between gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon aria-hidden className="size-5" />
        </span>
        <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {formats}
        </span>
      </span>
      <span className="font-semibold">{name}</span>
      <span className="text-sm text-muted-foreground">{description}</span>
      {children}
    </>
  );
}

function Tile({
  icon,
  name,
  description,
  formats,
  selected,
  onSelect,
  testId,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  formats: string;
  selected: boolean;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex min-h-11 flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        selected && 'border-primary ring-1 ring-primary',
      )}
      data-testid={testId}
    >
      <TileBody icon={icon} name={name} description={description} formats={formats} />
    </button>
  );
}

/** Vendor invoices: read from a PDF or photos on their own page, then approved (ADR 0049, 0054). */
function InvoiceTile({ queue }: { queue: boolean }) {
  const t = useT();
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border bg-card p-4 transition-shadow hover:shadow-md"
      data-testid="import-invoice"
    >
      <Link
        href="/inventory/invoice"
        className="flex flex-col gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="import-invoice-open"
      >
        <TileBody
          icon={ReceiptText}
          name={t('inventory.invoice.importDataTitle')}
          description={t('inventory.invoice.importDataHint')}
          formats={t('inventory.invoice.importDataFormats')}
        />
      </Link>
      {queue && (
        <Link
          href="/inventory/invoices"
          className="mt-auto flex items-center gap-1.5 self-start rounded-md text-sm font-medium text-primary hover:underline"
          data-testid="import-invoice-queue"
        >
          <ListChecks aria-hidden className="size-4" />
          {t('inventory.invoices.title')}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

function Preview({
  columns,
  fileName,
  rows,
  problems,
  busy,
  error,
  onImport,
  onCancel,
}: {
  columns: readonly string[];
  fileName: string;
  rows: Record<string, string>[];
  problems: DataImportProblemRow[];
  busy: boolean;
  error: string | null;
  onImport: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Card className="flex flex-col gap-4 p-5" data-testid="import-preview">
      <div className="flex flex-wrap items-center gap-2">
        <FileUp aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-medium">{fileName}</span>
        <span className="text-sm text-muted-foreground">
          {t('platform.importPage.rowCount', { count: String(rows.length) })}
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              {columns.map((c) => (
                <th key={c} className="px-3 py-2 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.slice(0, PREVIEW_ROWS).map((row, i) => (
              <tr key={i}>
                <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                {Object.entries(row).map(([field, value]) => (
                  <td key={field} className="px-3 py-2">
                    {field === 'unit' && isStockUnit(value) ? t(`inventory.units.${value}`) : value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_ROWS && (
        <p className="text-sm text-muted-foreground">
          {t('platform.importPage.previewMore', { count: String(rows.length - PREVIEW_ROWS) })}
        </p>
      )}
      {problems.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1" data-testid="import-problems">
          <p className="font-medium text-destructive">
            {t('platform.importPage.problems', { count: String(problems.length) })}
          </p>
          <ul className="text-sm">
            {problems.slice(0, PROBLEM_ROWS).map((p, i) => (
              <li key={i}>
                {t('platform.importPage.problemLine', {
                  row: String(p.row),
                  field: p.field,
                  problem: t(`platform.importPage.problem.${labelKey(p.problem)}`),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('platform.importPage.ready')}</p>
      )}
      <Notice text={error} tone="error" />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || problems.length > 0} onClick={onImport} data-testid="import-run">
          {t('platform.importPage.run', { count: String(rows.length) })}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('platform.common.cancel')}
        </Button>
      </div>
    </Card>
  );
}
