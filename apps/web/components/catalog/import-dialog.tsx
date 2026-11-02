'use client';

import {
  checkImportRows,
  type ImportProductRow,
  type ImportProductsResponse,
  type ImportRowProblem,
} from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { Download, FileUp } from 'lucide-react';
import { type ChangeEvent, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { importProducts } from '../../lib/catalog/api';
import { type CsvProblem, parseProductsCsv, PRODUCTS_CSV_TEMPLATE } from '../../lib/catalog/csv';
import { useActionKey } from '../../lib/use-action-key';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

const PREVIEW_ROWS = 5;
const FIELD_LABEL: Record<ImportRowProblem['field'], LabelKey> = {
  category: 'catalog.import.fields.category',
  name: 'catalog.import.fields.name',
  price: 'catalog.import.fields.price',
  taxRate: 'catalog.import.fields.taxRate',
  description: 'catalog.import.fields.description',
};
const PROBLEM_LABEL: Record<ImportRowProblem['problem'], LabelKey> = {
  required: 'catalog.import.problems.required',
  too_long: 'catalog.import.problems.tooLong',
  invalid: 'catalog.import.problems.invalid',
  duplicate: 'catalog.import.problems.duplicate',
};

type State =
  | { step: 'choose'; fileProblem: CsvProblem | null }
  | { step: 'preview'; rows: ImportProductRow[]; problems: ImportRowProblem[] }
  | { step: 'done'; result: ImportProductsResponse };

/**
 * Products from a CSV file (docs/modules/catalog.md → Import): the file is read here, checked with
 * the api's own rules (`checkImportRows`) and previewed; only a clean file can be imported.
 */
export function ImportDialog({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ step: 'choose', fileProblem: null });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([PRODUCTS_CSV_TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'products.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setError(null);
    if (!file) return;
    const parsed = parseProductsCsv(await file.text());
    setState(
      parsed.ok
        ? { step: 'preview', rows: parsed.rows, problems: checkImportRows(parsed.rows) }
        : { step: 'choose', fileProblem: parsed.problem },
    );
  }

  async function onImport(rows: ImportProductRow[]) {
    setBusy(true);
    setError(null);
    const result = await importProducts(store, action, rows);
    setBusy(false);
    if (result.ok && result.data) {
      setState({ step: 'done', result: result.data });
      onDone();
    } else {
      setError(t(errorLabel(result.ok ? 'unknown' : result.code)));
    }
  }

  const fileProblem = (problem: CsvProblem) => {
    switch (problem.kind) {
      case 'empty':
        return t('catalog.import.empty');
      case 'tooManyRows':
        return t('catalog.import.tooManyRows', { max: String(problem.max) });
      case 'missingColumns':
        return t('catalog.import.missingColumns', {
          columns: problem.columns.map((c) => t(FIELD_LABEL[c])).join(', '),
        });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setState({ step: 'choose', fileProblem: null });
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="import-open">
          <FileUp aria-hidden />
          {t('catalog.import.open')}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t('platform.common.close')} className="sm:max-w-2xl">
        <DialogTitle>{t('catalog.import.title')}</DialogTitle>
        <DialogDescription>{t('catalog.import.intro')}</DialogDescription>

        {state.step === 'done' ? (
          <p role="status" className="py-2 font-medium" data-testid="import-summary">
            {t('catalog.import.done', {
              created: String(state.result.created),
              updated: String(state.result.updated),
              unchanged: String(state.result.unchanged),
              categories: String(state.result.categoriesCreated),
            })}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <Button
                variant="ghost"
                className="px-0"
                onClick={downloadTemplate}
                data-testid="import-template"
              >
                <Download aria-hidden />
                {t('catalog.import.template')}
              </Button>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-file`}>{t('catalog.import.file')}</Label>
              <Input
                id={`${id}-file`}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void onFile(e)}
                data-testid="import-file"
              />
            </div>
            {state.step === 'choose' && state.fileProblem && (
              <Notice text={fileProblem(state.fileProblem)} tone="error" />
            )}
            {state.step === 'preview' && (
              <Preview
                rows={state.rows}
                problems={state.problems}
                fieldLabel={(f) => t(FIELD_LABEL[f])}
                problemLabel={(p) => t(PROBLEM_LABEL[p])}
              />
            )}
            <Notice text={error} tone="error" />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('platform.common.close')}
          </Button>
          {state.step === 'preview' && (
            <Button
              disabled={busy || state.problems.length > 0}
              onClick={() => void onImport(state.rows)}
              data-testid="import-submit"
            >
              {t('catalog.import.submit', { count: String(state.rows.length) })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Preview({
  rows,
  problems,
  fieldLabel,
  problemLabel,
}: {
  rows: ImportProductRow[];
  problems: ImportRowProblem[];
  fieldLabel: (field: ImportRowProblem['field']) => string;
  problemLabel: (problem: ImportRowProblem['problem']) => string;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 text-sm">
      {problems.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1" data-testid="import-problems">
          <p className="font-medium text-destructive">{t('catalog.import.problemsTitle')}</p>
          <ul className="max-h-40 list-inside list-disc overflow-y-auto">
            {problems.map((p) => (
              <li key={`${p.row}-${p.field}-${p.problem}`}>
                {t('catalog.import.problem', {
                  row: String(p.row),
                  field: fieldLabel(p.field),
                  problem: problemLabel(p.problem),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p data-testid="import-ready">{t('catalog.import.rows', { count: String(rows.length) })}</p>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-left" data-testid="import-preview">
          <thead className="border-b text-muted-foreground">
            <tr>
              {(['category', 'name', 'price', 'taxRate'] as const).map((f) => (
                <th key={f} className="px-3 py-2 font-medium">
                  {fieldLabel(f)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-1.5">{r.category}</td>
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5 tabular-nums">{r.price}</td>
                <td className="px-3 py-1.5 tabular-nums">{r.taxRate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_ROWS && (
        <p className="text-muted-foreground">
          {t('catalog.import.more', { count: String(rows.length - PREVIEW_ROWS) })}
        </p>
      )}
    </div>
  );
}
