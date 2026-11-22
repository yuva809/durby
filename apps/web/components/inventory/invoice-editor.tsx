'use client';

import {
  packProblems,
  type ProductCategory,
  STOCK_UNITS,
  type StockItem,
  type StockUnit,
  type UnitOfMeasure,
  type Warehouse,
} from '@durby/shared';
import { Plus, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { createCategory } from '../../lib/catalog/api';
import { createUnit } from '../../lib/inventory/api';
import { differsByRounding, lineValue, sumValues } from '../../lib/inventory/format';
import {
  type InvoiceRow,
  missingCategory,
  NEW_ITEM,
  retarget,
  type RowProblem,
  setMissingCategory,
} from '../../lib/inventory/invoice-receipt';
import { categoryPath } from '../../lib/inventory/overview';
import { useActionKey } from '../../lib/use-action-key';
import { cn } from '../../lib/utils';
import { Field, FormDialog } from '../form-dialog';
import { useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { ExpiryDate } from './expiry-date';

export interface InvoiceHeader {
  supplier: string;
  /** The supplier's invoice number and date, as printed (ADR 0055); editable when not read. */
  invoiceNumber: string;
  invoiceDate: string;
  note: string;
  warehouseId: string;
}

/** The included rows' value, 2 decimals. */
export function rowsTotal(rows: readonly InvoiceRow[]): string {
  return sumValues(
    rows
      .filter((r) => r.include)
      .map((r) => lineValue(r.quantity.replace(',', '.'), r.unitCost.replace(',', '.')) ?? '0'),
  );
}

/** The total against the printed one: equal, apart only from rounding piece prices (ADR 0058), or different. */
export function totalCheck(
  rows: readonly InvoiceRow[],
  printedTotal: string,
): 'matches' | 'rounding' | 'differs' {
  const total = rowsTotal(rows);
  if (total === printedTotal) return 'matches';
  const lines = rows
    .filter((r) => r.include)
    .map((r) => ({
      quantity: r.quantity.replace(',', '.'),
      unitCost: r.unitCost.replace(',', '.'),
    }));
  return differsByRounding(total, printedTotal, lines) ? 'rounding' : 'differs';
}

const NONE_SKIPPED: readonly string[] = [];

/**
 * The review of a vendor invoice (ADR 0049, 0054, 0055): supplier, note and warehouse, then each line: include, item or
 * New, and for new items their category (with "+" to add one), brand, pack size and unit; for every line the unit it
 * is invoiced in (a unit of measurement, "+" to add one), quantity, cost; the total against the printed one. Used to
 * submit an invoice and by approvers to correct a pending one; `actions` are the page's buttons.
 */
export function InvoiceEditor({
  header,
  onHeader,
  rows,
  onRows,
  problems,
  items,
  categories,
  units,
  warehouses,
  canCreate,
  canCreateCategory = false,
  canCreateUnit = false,
  onCategoryCreated,
  onUnitCreated,
  printedTotal,
  showCosts = true,
  skipped = NONE_SKIPPED,
  readOnly = false,
  actions,
}: {
  header: InvoiceHeader;
  onHeader: (patch: Partial<InvoiceHeader>) => void;
  rows: InvoiceRow[];
  onRows: (rows: InvoiceRow[]) => void;
  problems: RowProblem[][];
  items: readonly StockItem[];
  categories: readonly ProductCategory[] | null;
  units: readonly UnitOfMeasure[];
  warehouses: readonly Warehouse[];
  canCreate: boolean;
  canCreateCategory?: boolean;
  canCreateUnit?: boolean;
  onCategoryCreated?: (category: ProductCategory) => void;
  onUnitCreated?: (unit: UnitOfMeasure) => void;
  printedTotal: string | null;
  /**
   * The unit cost and value columns. The import leaves them out (they are still read from the invoice and saved,
   * ADR 0062); a line whose cost needs fixing shows them anyway.
   */
  showCosts?: boolean;
  /** Non-goods lines left out when reading (transport, "order confirmed", ADR 0058), by description. */
  skipped?: readonly string[];
  readOnly?: boolean;
  actions?: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const money = useMoney();
  const [bulkCategory, setBulkCategory] = useState('');
  const included = rows.filter((r) => r.include);
  const newCount = included.filter((r) => r.target === NEW_ITEM).length;
  const leftOut = rows.length - included.length;
  const supplierMissing = !readOnly && header.supplier.trim() === '';
  const withoutCategory = missingCategory(rows);
  const costsShown = showCosts || problems.some((p) => p.includes('unitCost'));
  const total = rowsTotal(rows);
  const check = printedTotal ? totalCheck(rows, printedTotal) : null;
  const sortedItems = [...items]
    .filter((i) => i.archivedAt === null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const activeCategories = (categories ?? []).filter((c) => c.archivedAt === null);
  const activeUnits = units.filter((u) => u.archivedAt === null);
  const update = (index: number, patch: Partial<InvoiceRow>) =>
    onRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-4" data-testid="invoice-review">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t('inventory.invoice.detailsTitle')}
          </h2>
          <ul className="flex flex-wrap gap-2" data-testid="invoice-summary">
            <Chip testId="invoice-count-items">
              {t('inventory.invoice.countItems', { count: String(rows.length) })}
            </Chip>
            <Chip testId="invoice-count-existing">
              {t('inventory.invoice.countExisting', {
                count: String(included.length - newCount),
              })}
            </Chip>
            <Chip testId="invoice-count-new" strong={newCount > 0}>
              {t('inventory.invoice.countNew', { count: String(newCount) })}
            </Chip>
            {leftOut > 0 && (
              <Chip testId="invoice-count-left-out">
                {t('inventory.invoice.countLeftOut', { count: String(leftOut) })}
              </Chip>
            )}
            {skipped.length > 0 && (
              <Chip testId="invoice-count-skipped">
                {t('inventory.invoice.skippedLines', { names: skipped.join(', ') })}
              </Chip>
            )}
          </ul>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${id}-supplier`}>{t('inventory.invoice.supplier')}</Label>
            <Input
              id={`${id}-supplier`}
              value={header.supplier}
              disabled={readOnly}
              placeholder={t('inventory.invoice.supplierPlaceholder')}
              maxLength={100}
              onChange={(e) => onHeader({ supplier: e.target.value })}
              className={cn(supplierMissing && 'border-destructive bg-destructive/5')}
              aria-describedby={supplierMissing ? `${id}-supplier-hint` : undefined}
              data-testid="invoice-supplier"
            />
            {supplierMissing && (
              <p
                id={`${id}-supplier-hint`}
                className="text-xs text-destructive"
                data-testid="invoice-supplier-hint"
              >
                {t('inventory.invoice.supplierMissing')}
              </p>
            )}
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${id}-number`}>{t('inventory.invoice.invoiceNumber')}</Label>
            <Input
              id={`${id}-number`}
              value={header.invoiceNumber}
              disabled={readOnly}
              maxLength={50}
              onChange={(e) => onHeader({ invoiceNumber: e.target.value })}
              data-testid="invoice-number"
            />
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${id}-date`}>{t('inventory.invoice.invoiceDate')}</Label>
            <Input
              id={`${id}-date`}
              value={header.invoiceDate}
              disabled={readOnly}
              maxLength={20}
              placeholder={t('inventory.invoice.invoiceDatePlaceholder')}
              onChange={(e) => onHeader({ invoiceDate: e.target.value })}
              data-testid="invoice-date"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-note`}>{t('inventory.invoice.note')}</Label>
            <Input
              id={`${id}-note`}
              value={header.note}
              disabled={readOnly}
              maxLength={500}
              onChange={(e) => onHeader({ note: e.target.value })}
              data-testid="invoice-note"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-warehouse`}>{t('inventory.fields.warehouse')}</Label>
            <Select
              id={`${id}-warehouse`}
              value={header.warehouseId}
              disabled={readOnly}
              onChange={(e) => onHeader({ warehouseId: e.target.value })}
              data-testid="invoice-warehouse"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span />
        {!readOnly && categories && withoutCategory > 0 && (
          <div className="flex flex-wrap items-center gap-2" data-testid="invoice-bulk-category">
            <Select
              value={bulkCategory}
              onChange={(e) => setBulkCategory(e.target.value)}
              aria-label={t('inventory.invoice.bulkCategory', { count: String(withoutCategory) })}
              className="w-56"
              data-testid="invoice-bulk-category-select"
            >
              <option value="">
                {t('inventory.invoice.bulkCategory', { count: String(withoutCategory) })}
              </option>
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryPath(categories, c.id)}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              disabled={bulkCategory === ''}
              onClick={() => {
                onRows(setMissingCategory(rows, bulkCategory));
                setBulkCategory('');
              }}
              data-testid="invoice-bulk-category-apply"
            >
              {t('inventory.invoice.bulkApply')}
            </Button>
          </div>
        )}
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[86rem] text-sm" data-testid="invoice-lines">
          <thead className="bg-muted text-left text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="w-10 px-3 py-2">
                <span className="sr-only">{t('inventory.invoice.include')}</span>
              </th>
              <th className="px-3 py-2 font-medium">{t('inventory.invoice.line')}</th>
              <th className="w-56 px-3 py-2 font-medium">{t('inventory.fields.item')}</th>
              <th className="w-52 px-3 py-2 font-medium">{t('inventory.invoice.category')}</th>
              <th className="w-36 px-3 py-2 font-medium">{t('inventory.invoice.brand')}</th>
              <th className="w-60 px-3 py-2 font-medium">{t('inventory.invoice.packSize')}</th>
              <th className="w-48 px-3 py-2 font-medium">{t('inventory.invoice.unit')}</th>
              <th className="w-24 px-3 py-2 text-right font-medium">
                {t('inventory.fields.quantity')}
              </th>
              <th className="w-40 px-3 py-2 font-medium">{t('inventory.fields.expiresOn')}</th>
              {costsShown && (
                <th className="w-28 px-3 py-2 text-right font-medium">
                  {t('inventory.invoice.unitCost')}
                </th>
              )}
              {costsShown && (
                <th className="w-28 px-3 py-2 text-right font-medium">
                  {t('inventory.fields.value')}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, index) => {
              const own = problems[index] ?? [];
              const fresh = row.target === NEW_ITEM;
              const item = fresh ? null : itemById.get(row.target);
              const baseUnit: StockUnit = item?.unit ?? row.newUnit;
              const purchaseUnits = activeUnits.filter((u) => u.baseUnit === baseUnit);
              const packBad = packProblems(row.pack);
              const value = lineValue(
                row.quantity.replace(',', '.'),
                row.unitCost.replace(',', '.'),
              );
              // Category, brand and pack size: a new item's, or set on the existing item when approved (ADR 0055).
              const editable = !readOnly;
              return (
                <tr
                  key={index}
                  className={cn('align-top', !row.include && 'opacity-50')}
                  data-testid="invoice-line"
                  data-code={row.line.code ?? ''}
                >
                  <td className="px-3 py-2">
                    <Checkbox
                      checked={row.include}
                      disabled={readOnly}
                      onCheckedChange={(next) => update(index, { include: next === true })}
                      aria-label={t('inventory.invoice.includeLine', {
                        name: row.line.description,
                      })}
                      data-testid="invoice-line-include"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{row.line.description}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {row.line.code}
                        {row.line.pack && (
                          <span data-testid="invoice-line-packed">
                            {t(
                              row.line.pack.unit
                                ? 'inventory.invoice.packLine'
                                : 'inventory.invoice.packLineNoUnit',
                              {
                                packs: row.line.pack.count,
                                unit: row.line.pack.unit ?? '',
                                per: row.line.pack.per,
                                pieces: row.line.pack.pieces,
                              },
                            )}
                          </span>
                        )}
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
                  <td className="px-3 py-2">
                    <Select
                      value={row.target}
                      disabled={readOnly}
                      onChange={(e) =>
                        onRows(
                          rows.map((r, i) =>
                            i === index ? retarget(r, e.target.value, items) : r,
                          ),
                        )
                      }
                      aria-label={t('inventory.invoice.itemFor', { name: row.line.description })}
                      data-testid="invoice-line-item"
                    >
                      <option value={NEW_ITEM} disabled={!canCreate && row.target !== NEW_ITEM}>
                        {t('inventory.invoice.newItem')}
                      </option>
                      {sortedItems.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.sku ? `${i.name} · ${i.sku}` : i.name}
                        </option>
                      ))}
                    </Select>
                    {row.include && fresh && canCreate && (
                      <Badge className="mt-1" data-testid="invoice-line-new">
                        {t('inventory.invoice.newBadge')}
                      </Badge>
                    )}
                    {own
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
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Select
                        value={row.categoryId}
                        disabled={!editable || !categories}
                        onChange={(e) => update(index, { categoryId: e.target.value })}
                        aria-label={t('inventory.invoice.categoryFor', {
                          name: row.line.description,
                        })}
                        data-testid="invoice-line-category"
                      >
                        <option value="">{t('inventory.page.uncategorized')}</option>
                        {activeCategories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {categoryPath(categories ?? [], c.id)}
                          </option>
                        ))}
                      </Select>
                      {editable && canCreateCategory && (
                        <NewCategory
                          onCreated={(category) => {
                            onCategoryCreated?.(category);
                            update(index, { categoryId: category.id });
                          }}
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      value={row.brand}
                      disabled={!editable}
                      maxLength={100}
                      placeholder="—"
                      onChange={(e) => update(index, { brand: e.target.value })}
                      aria-label={t('inventory.invoice.brandFor', { name: row.line.description })}
                      data-testid="invoice-line-brand"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1" data-testid="invoice-line-pack">
                      <div className="flex items-center gap-1">
                        <Input
                          inputMode="numeric"
                          value={row.pack.count}
                          disabled={!editable}
                          placeholder={t('inventory.invoice.packCount')}
                          aria-label={t('inventory.invoice.packCount')}
                          aria-invalid={packBad.includes('count') || undefined}
                          onChange={(e) =>
                            update(index, { pack: { ...row.pack, count: e.target.value } })
                          }
                          className="w-16 text-right"
                          data-testid="invoice-line-pack-count"
                        />
                        <span aria-hidden className="text-muted-foreground">
                          ×
                        </span>
                        <Input
                          inputMode="decimal"
                          value={row.pack.size}
                          disabled={!editable}
                          placeholder={t('inventory.invoice.packWeight')}
                          aria-label={t('inventory.invoice.packWeight')}
                          aria-invalid={packBad.includes('size') || undefined}
                          onChange={(e) =>
                            update(index, { pack: { ...row.pack, size: e.target.value } })
                          }
                          className="w-20 text-right"
                          data-testid="invoice-line-pack-size"
                        />
                        <Select
                          value={row.pack.unit}
                          disabled={!editable}
                          aria-label={t('inventory.invoice.packUnit')}
                          aria-invalid={packBad.includes('unit') || undefined}
                          onChange={(e) =>
                            update(index, {
                              pack: { ...row.pack, unit: e.target.value as StockUnit | '' },
                            })
                          }
                          className="w-20"
                          data-testid="invoice-line-pack-unit"
                        >
                          <option value="">–</option>
                          {STOCK_UNITS.filter((u) => u !== 'pc').map((u) => (
                            <option key={u} value={u}>
                              {t(`inventory.units.${u}`)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <span
                        className={cn(
                          'text-xs',
                          packBad.length > 0 ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {packBad.length > 0
                          ? t('inventory.invoice.packInvalid')
                          : t('inventory.invoice.packHint')}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      {fresh && (
                        <Select
                          value={row.newUnit}
                          disabled={!editable}
                          onChange={(e) =>
                            // The invoiced-in unit belongs to the item's unit: start again.
                            update(index, { newUnit: e.target.value as StockUnit, unitId: '' })
                          }
                          aria-label={t('inventory.invoice.itemUnit')}
                          data-testid="invoice-line-unit"
                        >
                          {STOCK_UNITS.map((u) => (
                            <option key={u} value={u}>
                              {t(`inventory.units.${u}`)}
                            </option>
                          ))}
                        </Select>
                      )}
                      <div className="flex items-center gap-1">
                        <Select
                          value={row.unitId}
                          disabled={readOnly}
                          onChange={(e) => update(index, { unitId: e.target.value })}
                          aria-label={t('inventory.invoice.invoicedIn')}
                          data-testid="invoice-line-invoiced-in"
                        >
                          <option value="">
                            {t('inventory.invoice.perUnit', {
                              unit: t(`inventory.units.${baseUnit}`),
                            })}
                          </option>
                          {purchaseUnits.map((u) => (
                            <option key={u.id} value={u.id}>
                              {t('inventory.invoice.unitOption', {
                                name: u.name,
                                factor: u.factor.replace(/\.?0+$/, ''),
                                unit: t(`inventory.units.${u.baseUnit}`),
                              })}
                            </option>
                          ))}
                        </Select>
                        {!readOnly && canCreateUnit && (
                          <NewUnit
                            baseUnit={baseUnit}
                            onCreated={(unit) => {
                              onUnitCreated?.(unit);
                              update(index, { unitId: unit.id });
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      inputMode="decimal"
                      className="text-right"
                      value={row.quantity}
                      disabled={readOnly}
                      aria-label={t('inventory.fields.quantity')}
                      aria-invalid={own.includes('quantity') || undefined}
                      onChange={(e) => update(index, { quantity: e.target.value })}
                      data-testid="invoice-line-quantity"
                    />
                  </td>
                  <td className="px-3 py-2">
                    {readOnly ? (
                      <ExpiryDate value={row.expiresOn || null} />
                    ) : (
                      <Input
                        type="date"
                        value={row.expiresOn}
                        onChange={(e) => update(index, { expiresOn: e.target.value })}
                        aria-label={t('inventory.invoice.expiryFor', {
                          name: row.line.description,
                        })}
                        data-testid="invoice-line-expiry"
                      />
                    )}
                  </td>
                  {costsShown && (
                    <td className="px-3 py-2">
                      <Input
                        inputMode="decimal"
                        className="text-right"
                        value={row.unitCost}
                        disabled={readOnly}
                        aria-label={t('inventory.invoice.unitCost')}
                        aria-invalid={own.includes('unitCost') || undefined}
                        onChange={(e) => update(index, { unitCost: e.target.value })}
                        data-testid="invoice-line-cost"
                      />
                    </td>
                  )}
                  {costsShown && (
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {value ? money(value) : '–'}
                    </td>
                  )}
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
          {printedTotal && check && (
            <p
              className={cn(
                'text-sm',
                check === 'differs' ? 'text-destructive' : 'text-muted-foreground',
              )}
              data-testid="invoice-total-check"
            >
              {check === 'matches' &&
                t('inventory.invoice.totalMatches', { amount: money(printedTotal) })}
              {check === 'rounding' &&
                t('inventory.invoice.totalMatchesRounding', {
                  amount: money(printedTotal),
                  difference: money(sumValues([total, `-${printedTotal}`])),
                })}
              {check === 'differs' &&
                t('inventory.invoice.totalDiffersSimple', { amount: money(printedTotal) })}
            </p>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </Card>
    </div>
  );
}

/** One count above the review ("55 items", "39 new"). */
function Chip({
  children,
  strong = false,
  testId,
}: {
  children: ReactNode;
  strong?: boolean;
  testId: string;
}) {
  return (
    <li
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase',
        strong
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'bg-muted text-muted-foreground',
      )}
      data-testid={testId}
    >
      {children}
    </li>
  );
}

/** "+" next to a line's category: a category by name, chosen for the line at once. */
function NewCategory({ onCreated }: { onCreated: (category: ProductCategory) => void }) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [name, setName] = useState('');
  const [checked, setChecked] = useState(false);
  const created = useRef<ProductCategory | null>(null);
  return (
    <FormDialog
      trigger={t('inventory.invoice.addCategory')}
      triggerIcon={<Plus aria-hidden />}
      triggerVariant="outline"
      triggerClassName="size-9 shrink-0"
      testId="invoice-add-category"
      title={t('inventory.invoice.addCategory')}
      onOpen={() => {
        setName('');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '') return null;
        return createCategory(store, action, { name: name.trim() }).then((result) => {
          if (result.ok && result.data) created.current = result.data;
          return result;
        });
      }}
      onDone={() => {
        if (created.current) onCreated(created.current);
      }}
    >
      <Field
        id={`${id}-name`}
        label={t('inventory.fields.name')}
        problem={checked && name.trim() === '' ? t('inventory.page.nameRequired') : null}
      >
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          data-testid="invoice-add-category-name"
        />
      </Field>
    </FormDialog>
  );
}

/** "+" next to the invoiced-in unit: e.g. Carton = 12 pc, in the line's item unit, chosen for the line at once. */
function NewUnit({
  baseUnit,
  onCreated,
}: {
  baseUnit: StockUnit;
  onCreated: (unit: UnitOfMeasure) => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const action = useActionKey();
  const [name, setName] = useState('');
  const [factor, setFactor] = useState('');
  const [checked, setChecked] = useState(false);
  const cleanFactor = factor.trim().replace(',', '.');
  const factorBad = !/^\d{1,8}(\.\d{1,6})?$/.test(cleanFactor) || !/[1-9]/.test(cleanFactor);
  const created = useRef<UnitOfMeasure | null>(null);
  return (
    <FormDialog
      trigger={t('inventory.invoice.addUnit')}
      triggerIcon={<Plus aria-hidden />}
      triggerVariant="outline"
      triggerClassName="size-9 shrink-0"
      testId="invoice-add-unit"
      title={t('inventory.invoice.addUnit')}
      onOpen={() => {
        setName('');
        setFactor('');
        setChecked(false);
      }}
      submit={() => {
        setChecked(true);
        if (name.trim() === '' || factorBad) return null;
        return createUnit(store, action, {
          name: name.trim(),
          symbol: name.trim().slice(0, 20),
          baseUnit,
          factor: cleanFactor,
        }).then((result) => {
          if (result.ok && result.data) created.current = result.data;
          return result;
        });
      }}
      onDone={() => {
        if (created.current) onCreated(created.current);
      }}
    >
      <Field
        id={`${id}-name`}
        label={t('inventory.invoice.unitName')}
        problem={checked && name.trim() === '' ? t('inventory.page.nameRequired') : null}
      >
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={100}
          placeholder={t('inventory.invoice.unitNamePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          data-testid="invoice-add-unit-name"
        />
      </Field>
      <Field
        id={`${id}-factor`}
        label={t('inventory.invoice.unitFactor', { unit: t(`inventory.units.${baseUnit}`) })}
        problem={checked && factorBad ? t('inventory.invoice.unitFactorInvalid') : null}
      >
        <Input
          id={`${id}-factor`}
          inputMode="decimal"
          value={factor}
          onChange={(e) => setFactor(e.target.value)}
          data-testid="invoice-add-unit-factor"
        />
      </Field>
    </FormDialog>
  );
}
