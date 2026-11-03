'use client';

import {
  type PriceChange,
  type Product,
  type ProductBulkAction,
  type ProductCategory,
  newPrice,
  PRICE_CHANGE_MODES,
  priceChangeSchema,
  taxRateSchema,
} from '@durby/shared';
import { useId, useRef, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import type { Result } from '../../lib/api-call';
import { errorLabel } from '../../lib/auth/errors';
import { bulkCategories, bulkProducts } from '../../lib/catalog/api';
import { useActionKey } from '../../lib/use-action-key';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { ConfirmAction } from '../users/common';
import { Field, FormDialog } from '../form-dialog';

/** Rows a delete kept because they were sold: named, with archive as the next step. */
export interface KeptRows {
  kind: 'products' | 'categories';
  items: { id: string; name: string }[];
}

const PREVIEW_ROWS = 5;

/**
 * The bar of the selected products and categories (docs/modules/catalog.md → Web → Bulk actions).
 * On phones it sits at the bottom of the screen. `onDone` runs after any action, with the rows a
 * delete kept (or null).
 */
export function BulkBar({
  products,
  categories,
  openCategories,
  onClear,
  onDone,
}: {
  products: Product[];
  categories: ProductCategory[];
  /** Non-archived categories: the targets of a move. */
  openCategories: ProductCategory[];
  onClear: () => void;
  onDone: (kept: KeptRows | null) => void;
}) {
  const t = useT();
  const count = products.length + categories.length;
  if (count === 0) return null;
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2 border-t border-border bg-background p-3 shadow-lg lg:sticky lg:inset-x-auto lg:top-2 lg:bottom-auto lg:rounded-md lg:border lg:shadow-md"
      data-testid="bulk-bar"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium" role="status">
          {t('catalog.bulk.selected', { count: String(count) })}
        </p>
        <Button variant="ghost" onClick={onClear} data-testid="bulk-clear">
          {t('catalog.bulk.clear')}
        </Button>
      </div>
      {products.length > 0 && (
        <ProductActions
          products={products}
          openCategories={openCategories}
          onDone={(response) => onDone(keptOf('products', response, products))}
        />
      )}
      {categories.length > 0 && (
        <CategoryActions
          categories={categories}
          onDone={(response) => onDone(keptOf('categories', response, categories))}
        />
      )}
    </div>
  );
}

function keptOf(
  kind: KeptRows['kind'],
  response: { kept: { id: string }[] } | null,
  selected: { id: string; name: string }[],
): KeptRows | null {
  const names = new Map(selected.map((row) => [row.id, row.name]));
  const items = (response?.kept ?? []).map((k) => ({ id: k.id, name: names.get(k.id) ?? k.id }));
  return items.length > 0 ? { kind, items } : null;
}

type ProductResponse = Awaited<ReturnType<typeof bulkProducts>>;

function ProductActions({
  products,
  openCategories,
  onDone,
}: {
  products: Product[];
  openCategories: ProductCategory[];
  onDone: (response: { kept: { id: string }[] } | null) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const ids = products.map((p) => p.id);
  const count = String(products.length);
  /** Sends the action; the answer is kept for `onDone` once the dialog has closed. */
  const last = useRef<{ kept: { id: string }[] } | null>(null);
  const run = async (body: ProductBulkAction): Promise<ProductResponse> => {
    const result = await bulkProducts(store, action, { ids, action: body });
    last.current = result.ok ? result.data : null;
    return result;
  };
  const done = () => onDone(last.current);

  return (
    <div className="flex flex-wrap gap-2" data-testid="bulk-products">
      {openCategories.length > 0 && (
        <MoveDialog count={count} categories={openCategories} run={run} onDone={done} />
      )}
      <VatDialog count={count} run={run} onDone={done} />
      <PriceDialog products={products} run={run} onDone={done} />
      <Immediate
        label={t('catalog.bulk.restore')}
        testId="bulk-restore"
        run={() => run({ kind: 'restore' })}
        onDone={done}
      />
      <ConfirmAction
        testId="bulk-archive"
        trigger={t('catalog.bulk.archive')}
        title={t('catalog.bulk.archiveTitle', { count })}
        description={t('catalog.bulk.archiveDescription')}
        confirm={t('catalog.bulk.archive')}
        run={() => run({ kind: 'archive' })}
        onDone={done}
      />
      <ConfirmAction
        testId="bulk-delete"
        trigger={t('catalog.bulk.delete')}
        title={t('catalog.bulk.deleteProductsTitle', { count })}
        description={t('catalog.bulk.deleteProductsDescription')}
        confirm={t('catalog.bulk.delete')}
        run={() => run({ kind: 'delete' })}
        onDone={done}
      />
    </div>
  );
}

function CategoryActions({
  categories,
  onDone,
}: {
  categories: ProductCategory[];
  onDone: (response: { kept: { id: string }[] } | null) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const ids = categories.map((c) => c.id);
  const count = String(categories.length);
  const last = useRef<{ kept: { id: string }[] } | null>(null);
  const run = async (kind: 'archive' | 'restore' | 'delete') => {
    const result = await bulkCategories(store, action, { ids, action: kind });
    last.current = result.ok ? result.data : null;
    return result;
  };
  const done = () => onDone(last.current);

  return (
    <div className="flex flex-wrap gap-2" data-testid="bulk-categories">
      <Immediate
        label={t('catalog.bulk.restore')}
        testId="bulk-category-restore"
        run={() => run('restore')}
        onDone={done}
      />
      <ConfirmAction
        testId="bulk-category-archive"
        trigger={t('catalog.bulk.archive')}
        title={t('catalog.bulk.archiveTitle', { count })}
        description={t('catalog.bulk.archiveDescription')}
        confirm={t('catalog.bulk.archive')}
        run={() => run('archive')}
        onDone={done}
      />
      <ConfirmAction
        testId="bulk-category-delete"
        trigger={t('catalog.bulk.delete')}
        title={t('catalog.bulk.deleteCategoriesTitle', { count })}
        description={t('catalog.bulk.deleteCategoriesDescription')}
        confirm={t('catalog.bulk.delete')}
        run={() => run('delete')}
        onDone={done}
      />
    </div>
  );
}

/** An action without a confirm (restoring loses nothing); a failure shows beside the button. */
function Immediate({
  label,
  testId,
  run,
  onDone,
}: {
  label: string;
  testId: string;
  run: () => Promise<Result<unknown>>;
  onDone: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        disabled={busy}
        data-testid={testId}
        onClick={() => {
          setBusy(true);
          setError(null);
          void run().then((result) => {
            setBusy(false);
            if (result.ok) onDone();
            else setError(t(errorLabel(result.code)));
          });
        }}
      >
        {label}
      </Button>
      <Notice text={error} tone="error" />
    </div>
  );
}

type Run = (body: ProductBulkAction) => Promise<ProductResponse>;

function MoveDialog({
  count,
  categories,
  run,
  onDone,
}: {
  count: string;
  categories: ProductCategory[];
  run: Run;
  onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const [categoryId, setCategoryId] = useState('');
  return (
    <FormDialog
      trigger={t('catalog.bulk.move')}
      triggerVariant="outline"
      testId="bulk-move"
      title={t('catalog.bulk.moveTitle', { count })}
      onOpen={() => setCategoryId(categories[0]?.id ?? '')}
      submit={() => (categoryId === '' ? null : run({ kind: 'move', categoryId }))}
      onDone={onDone}
    >
      <Field id={`${id}-category`} label={t('catalog.fields.category')} problem={null}>
        <Select
          id={`${id}-category`}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}

function VatDialog({ count, run, onDone }: { count: string; run: Run; onDone: () => void }) {
  const t = useT();
  const id = useId();
  const [taxRate, setTaxRate] = useState('');
  const [checked, setChecked] = useState(false);
  const valid = taxRateSchema.safeParse(taxRate.trim()).success;
  const problem = checked && !valid ? t('catalog.page.taxRateInvalid') : null;
  return (
    <FormDialog
      trigger={t('catalog.bulk.vat')}
      triggerVariant="outline"
      testId="bulk-vat"
      title={t('catalog.bulk.vatTitle', { count })}
      onOpen={() => {
        setTaxRate('');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        return valid ? run({ kind: 'vat', taxRate: taxRate.trim() }) : null;
      }}
      onDone={onDone}
    >
      <Field id={`${id}-tax`} label={t('catalog.fields.taxRate')} problem={problem}>
        <Input
          id={`${id}-tax`}
          inputMode="decimal"
          value={taxRate}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setTaxRate(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

/** Set / ± amount / ± %, previewing the new prices with the same math as the api (`newPrice`). */
function PriceDialog({
  products,
  run,
  onDone,
}: {
  products: Product[];
  run: Run;
  onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const [mode, setMode] = useState<PriceChange['mode']>('percent');
  const [value, setValue] = useState('');
  const [checked, setChecked] = useState(false);
  const parsed = priceChangeSchema.safeParse({ mode, value: value.trim() });
  const change = parsed.success ? parsed.data : null;
  const problem = checked && !change ? t('catalog.bulk.priceValueInvalid') : null;

  return (
    <FormDialog
      trigger={t('catalog.bulk.price')}
      triggerVariant="outline"
      testId="bulk-price"
      title={t('catalog.bulk.priceTitle', { count: String(products.length) })}
      onOpen={() => {
        setMode('percent');
        setValue('');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        return change ? run({ kind: 'price', change }) : null;
      }}
      onDone={onDone}
    >
      <Field id={`${id}-mode`} label={t('catalog.bulk.priceMode')} problem={null}>
        <Select
          id={`${id}-mode`}
          value={mode}
          onChange={(e) => setMode(e.target.value as PriceChange['mode'])}
        >
          {PRICE_CHANGE_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`catalog.bulk.priceModes.${m}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`${id}-value`} label={t('catalog.bulk.priceValue')} problem={problem}>
        <Input
          id={`${id}-value`}
          inputMode="decimal"
          value={value}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      {change && (
        <div className="grid gap-1 text-sm" data-testid="bulk-price-preview">
          <p className="font-medium">{t('catalog.bulk.preview')}</p>
          <ul>
            {products.slice(0, PREVIEW_ROWS).map((p) => (
              <li key={p.id} className="tabular-nums">
                {t('catalog.bulk.previewRow', {
                  name: p.name,
                  from: p.price,
                  to: newPrice(p.price, change) ?? t('catalog.bulk.previewInvalid'),
                })}
              </li>
            ))}
          </ul>
          {products.length > PREVIEW_ROWS && (
            <p className="text-muted-foreground">
              {t('catalog.bulk.previewMore', { count: String(products.length - PREVIEW_ROWS) })}
            </p>
          )}
        </div>
      )}
    </FormDialog>
  );
}
