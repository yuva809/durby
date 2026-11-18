'use client';

import {
  type ProductCategory,
  STOCK_UNITS,
  type StockItem,
  type StockUnit,
  type Warehouse,
} from '@durby/shared';
import { TriangleAlert } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../app/labels-provider';
import { lineValue, sumValues } from '../../lib/inventory/format';
import { type InvoiceRow, NEW_ITEM, type RowProblem } from '../../lib/inventory/invoice-receipt';
import { categoryPath } from '../../lib/inventory/overview';
import { cn } from '../../lib/utils';
import { useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';

export interface InvoiceHeader {
  supplier: string;
  note: string;
  warehouseId: string;
  newItemUnit: StockUnit;
  newItemCategoryId: string;
}

/** The included rows' value, 2 decimals. */
export function rowsTotal(rows: readonly InvoiceRow[]): string {
  return sumValues(
    rows
      .filter((r) => r.include)
      .map((r) => lineValue(r.quantity.replace(',', '.'), r.unitCost.replace(',', '.')) ?? '0'),
  );
}

/**
 * The review of a vendor invoice (ADR 0049, 0054): supplier, note, warehouse and how new items are created, then
 * each line (include, item or New, quantity, cost) and the total against the printed one. Used to submit an invoice
 * and by approvers to correct a pending one; `actions` are the page's buttons. `readOnly` shows a decided one.
 */
export function InvoiceEditor({
  header,
  onHeader,
  rows,
  onRows,
  problems,
  items,
  categories,
  warehouses,
  canCreate,
  printedTotal,
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
  warehouses: readonly Warehouse[];
  canCreate: boolean;
  printedTotal: string | null;
  readOnly?: boolean;
  actions?: ReactNode;
}) {
  const t = useT();
  const id = useId();
  const money = useMoney();
  const included = rows.filter((r) => r.include);
  const newCount = included.filter((r) => r.target === NEW_ITEM).length;
  const total = rowsTotal(rows);
  const sortedItems = [...items]
    .filter((i) => i.archivedAt === null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const update = (index: number, patch: Partial<InvoiceRow>) =>
    onRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-4" data-testid="invoice-review">
      <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-supplier`}>{t('inventory.invoice.supplier')}</Label>
          <Input
            id={`${id}-supplier`}
            value={header.supplier}
            disabled={readOnly}
            placeholder={t('inventory.invoice.supplierPlaceholder')}
            maxLength={100}
            onChange={(e) => onHeader({ supplier: e.target.value })}
            data-testid="invoice-supplier"
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
        {newCount > 0 && !readOnly && (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-unit`}>{t('inventory.invoice.newUnit')}</Label>
              <Select
                id={`${id}-unit`}
                value={header.newItemUnit}
                onChange={(e) => onHeader({ newItemUnit: e.target.value as StockUnit })}
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
                  value={header.newItemCategoryId}
                  onChange={(e) => onHeader({ newItemCategoryId: e.target.value })}
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

      <p className="text-sm text-muted-foreground" data-testid="invoice-summary">
        {t('inventory.invoice.summary', {
          lines: String(rows.length),
          matched: String(included.length - newCount),
          fresh: String(newCount),
        })}
      </p>

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
              const own = problems[index] ?? [];
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
                      disabled={readOnly}
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
                      disabled={readOnly}
                      onChange={(e) => update(index, { target: e.target.value })}
                      aria-label={t('inventory.invoice.itemFor', { name: row.line.description })}
                      data-testid="invoice-line-item"
                    >
                      <option value={NEW_ITEM} disabled={!canCreate && row.target !== NEW_ITEM}>
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
                  <td className="px-3 py-2 align-top">
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
                  <td className="px-3 py-2 align-top">
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
          {printedTotal && (
            <p
              className={cn(
                'text-sm',
                total === printedTotal ? 'text-muted-foreground' : 'text-destructive',
              )}
              data-testid="invoice-total-check"
            >
              {total === printedTotal
                ? t('inventory.invoice.totalMatches', { amount: money(printedTotal) })
                : t('inventory.invoice.totalDiffersSimple', { amount: money(printedTotal) })}
            </p>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </Card>
    </div>
  );
}
