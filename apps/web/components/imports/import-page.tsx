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
  IMPORT_KINDS,
  IMPORT_TEMPLATES,
  type ImportKind,
  type ItemImportRow,
  type OpeningStockImportRow,
  type PermissionKey,
  type FeatureKey,
} from '@durby/shared';
import { Download, FileUp } from 'lucide-react';
import { type ChangeEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { runImport } from '../../lib/imports/api';
import { readRows, type TableProblem, templateCsv } from '../../lib/imports/table';
import { loadStockItems, loadWarehouses } from '../../lib/inventory/api';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Label } from '../ui/label';
import { NoAccess } from '../users/common';

/** Who may import what: the key of the module that owns the records (the api checks the same). */
const ACCESS: Readonly<Record<ImportKind, { feature: FeatureKey; permission: PermissionKey }>> = {
  categories: { feature: 'catalog', permission: 'catalog.products.create' },
  items: { feature: 'inventory', permission: 'inventory.items.create' },
  opening_stock: { feature: 'inventory', permission: 'inventory.stock.receive' },
  customers: { feature: 'orders', permission: 'orders.customers.create' },
};

/** `opening_stock` → `openingStock`: label keys are camelCase. */
const labelKey = <T extends string>(value: T) =>
  value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as T extends `${infer A}_${infer B}`
    ? `${A}${Capitalize<B>}`
    : T;

const PREVIEW_ROWS = 10;
const PROBLEM_ROWS = 50;

/**
 * /import, Import Data (docs/platform/import.md, ADR 0044 step 4): pick what to import, download its template, choose a
 * CSV file, check the preview and its problems, then import all rows at once (all or nothing).
 */
export function ImportPage() {
  const { session } = useAuth();
  if (!session) return null;
  const kinds = IMPORT_KINDS.filter(
    (kind) =>
      session.activeFeatures.includes(ACCESS[kind].feature) &&
      session.activePermissions.includes(ACCESS[kind].permission),
  );
  if (kinds.length === 0) return <NoAccess title="platform.nav.importData" />;
  return <Importer kinds={kinds} organizationId={session.activeOrganizationId} />;
}

type State =
  | { step: 'choose'; problem: TableProblem | null }
  | { step: 'preview'; fileName: string; rows: Record<string, string>[] }
  | { step: 'done'; result: DataImportResult };

function Importer({
  kinds,
  organizationId,
}: {
  kinds: ImportKind[];
  organizationId: string | null;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [kind, setKind] = useState<ImportKind>(kinds[0]!);
  const [state, setState] = useState<State>({ step: 'choose', problem: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opening stock names warehouses and items: the preview checks them against what exists.
  const needsRefs = kind === 'opening_stock' && organizationId !== null;
  const [warehouses] = useResource(needsRefs ? organizationId : null, () => loadWarehouses(store));
  const [items] = useResource(needsRefs ? organizationId : null, () => loadStockItems(store));

  const pick = (next: ImportKind) => {
    setKind(next);
    setState({ step: 'choose', problem: null });
    setError(null);
  };

  const problemsOf = (rows: Record<string, string>[]): DataImportProblemRow[] => {
    switch (kind) {
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

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([templateCsv(kind)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kind.replace('_', '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setError(null);
    if (!file) return;
    const read = readRows(kind, await file.text());
    setState(
      read.ok
        ? { step: 'preview', fileName: file.name, rows: read.rows }
        : { step: 'choose', problem: read.problem },
    );
    // The same file can be chosen again after fixing it.
    event.target.value = '';
  }

  async function onImport(rows: Record<string, string>[]) {
    setBusy(true);
    setError(null);
    const result = await runImport(store, action, kind, rows);
    setBusy(false);
    if (result.ok && result.data) setState({ step: 'done', result: result.data });
    else setError(t(errorLabel(result.ok ? 'unknown' : result.code)));
  }

  const tableProblem = (problem: TableProblem) => {
    switch (problem.kind) {
      case 'empty':
        return t('platform.importPage.empty');
      case 'tooManyRows':
        return t('platform.importPage.tooManyRows', { max: String(problem.max) });
      case 'missingColumns':
        return t('platform.importPage.missingColumns', { columns: problem.columns.join(', ') });
    }
  };

  const columns = IMPORT_TEMPLATES[kind];
  const rows = state.step === 'preview' ? state.rows : [];
  const problems = state.step === 'preview' ? problemsOf(rows) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('platform.nav.importData')}</h1>
        <p className="text-muted-foreground">{t('platform.importPage.intro')}</p>
      </div>

      <div
        role="radiogroup"
        aria-label={t('platform.importPage.what')}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === kind}
            onClick={() => pick(k)}
            className={cn(
              'flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-4 text-left hover:bg-muted',
              k === kind && 'border-primary ring-1 ring-primary',
            )}
            data-testid={`import-kind-${k}`}
          >
            <span className="font-medium">
              {t(`platform.importPage.kinds.${labelKey(k)}.name`)}
            </span>
            <span className="text-sm text-muted-foreground">
              {t(`platform.importPage.kinds.${labelKey(k)}.description`)}
            </span>
          </button>
        ))}
      </div>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('platform.importPage.columns')}</span>
            <code className="text-sm" data-testid="import-columns">
              {columns.join(', ')}
            </code>
          </div>
          <Button variant="outline" onClick={downloadTemplate} data-testid="import-template">
            <Download aria-hidden />
            {t('platform.importPage.template')}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(`platform.importPage.kinds.${labelKey(kind)}.rules`)}
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-file`}>{t('platform.importPage.file')}</Label>
          <input
            id={`${id}-file`}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void onFile(e)}
            className="text-sm file:mr-3 file:min-h-11 file:rounded-md file:border file:bg-card file:px-4 file:font-medium"
            data-testid="import-file"
          />
        </div>
        {state.step === 'choose' && state.problem && (
          <Notice text={tableProblem(state.problem)} tone="error" />
        )}
      </Card>

      {state.step === 'preview' && (
        <Card className="flex flex-col gap-4 p-4" data-testid="import-preview">
          <div className="flex flex-wrap items-center gap-2">
            <FileUp aria-hidden className="size-4 text-muted-foreground" />
            <span className="font-medium">{state.fileName}</span>
            <span className="text-sm text-muted-foreground">
              {t('platform.importPage.rowCount', { count: String(rows.length) })}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-2 py-1 font-medium">#</th>
                  {columns.map((c) => (
                    <th key={c} className="px-2 py-1 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                    {Object.values(row).map((value, j) => (
                      <td key={j} className="px-2 py-1">
                        {value}
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
            <Button
              disabled={busy || problems.length > 0}
              onClick={() => void onImport(rows)}
              data-testid="import-run"
            >
              {t('platform.importPage.run', { count: String(rows.length) })}
            </Button>
            <Button variant="ghost" onClick={() => setState({ step: 'choose', problem: null })}>
              {t('platform.common.cancel')}
            </Button>
          </div>
        </Card>
      )}

      {state.step === 'done' && (
        <Card className="flex flex-col gap-2 p-4" role="status" data-testid="import-done">
          <p className="font-medium">{t('platform.importPage.done')}</p>
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
