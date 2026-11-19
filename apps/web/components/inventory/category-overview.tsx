'use client';

import type { ProductCategory } from '@durby/shared';
import { ArrowLeft, Boxes, Download, LayoutGrid, Package, Search } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { categoryColor, useCategoryImage } from '../../lib/catalog/category-image';
import { loadStock } from '../../lib/inventory/api';
import { shortQuantity } from '../../lib/inventory/format';
import {
  type CategorySelection,
  type CategoryTile,
  categoryPath,
  categoryTiles,
  inSelection,
  inStockState,
  type ItemRow,
  itemRows,
  secondaryCategories,
  type StockState,
  sumDecimals,
  toCsv,
} from '../../lib/inventory/overview';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { useMoney } from '../pos/money';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Loaded } from '../users/common';
import { type InventoryData, warehouseLabel } from './inventory-page';
import { useSeesPrices } from './use-sees-prices';
import { ExpiryDate } from './expiry-date';
import { BranchShop } from '../requests/branch-shop';

const selectionKey = (s: CategorySelection) =>
  s.kind === 'category' ? s.id : s.kind === 'none' ? 'none' : '';
const selectionOf = (key: string): CategorySelection =>
  key === '' ? { kind: 'all' } : key === 'none' ? { kind: 'none' } : { kind: 'category', id: key };

/**
 * The inventory page of the operations menu (docs/modules/inventory.md → Overview, ADR 0048): filters, then the
 * categories as tiles (All items, each top-level category, Uncategorized) with their item counts; a tile opens its
 * items with their stock. The page header comes with it: Export downloads what is listed; `actions` follow it.
 */
export function CategoryOverview({
  data,
  actions,
  branchShop = false,
}: {
  data: InventoryData;
  actions: ReactNode;
  /** A branch's view (ADR 0065): a category lists what the main warehouse has, with the request cart. */
  branchShop?: boolean;
}) {
  const t = useT();
  // A branch sees quantities only (ADR 0060): no value column, total or export column.
  const prices = useSeesPrices();
  const id = useId();
  const money = useMoney();
  const { store } = useAuth();
  const categories = data.categories ?? [];
  const active = data.warehouses.filter((w) => w.archivedAt === null && !w.isTransit);
  const [warehouseId, setWarehouseId] = useState('');
  const [stockState, setStockState] = useState<StockState>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<CategorySelection | null>(null);
  const [stock, reload] = useResource(`overview:${warehouseId}`, () =>
    loadStock(store, warehouseId ? { warehouseId } : {}),
  );

  // What is listed, for the page and for Export: the open category's items, else what the search finds, else all.
  const needle = query.trim().toLowerCase();
  const matching = (r: ItemRow) =>
    needle === '' ||
    r.item.name.toLowerCase().includes(needle) ||
    (r.item.sku ?? '').toLowerCase().includes(needle);
  const rows =
    stock.status === 'ready'
      ? itemRows(data.items, stock.data).filter((r) => inStockState(r, stockState))
      : [];
  const listed = open
    ? rows.filter((r) => inSelection(r, open, categories) && matching(r))
    : rows.filter(matching);

  function exportCsv() {
    const csv = toCsv(
      [
        t('inventory.fields.item'),
        t('inventory.fields.sku'),
        t('inventory.fields.category'),
        t('inventory.fields.unit'),
        t('inventory.fields.quantity'),
        ...(prices ? [t('inventory.fields.value')] : []),
        t('inventory.overview.lowStock'),
      ],
      listed.map((r) => [
        r.item.name,
        r.item.sku ?? '',
        categoryPath(categories, r.item.categoryId),
        t(`inventory.units.${r.item.unit}`),
        shortQuantity(r.quantity),
        ...(prices ? [r.value ?? ''] : []),
        r.low ? t('inventory.overview.yes') : '',
      ]),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${t('inventory.overview.exportFile')}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('inventory.nav.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t(prices ? 'inventory.overview.intro' : 'inventory.overview.introQuantities')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2" data-testid="overview-actions">
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={stock.status !== 'ready' || listed.length === 0}
            data-testid="overview-export"
          >
            <Download aria-hidden />
            {t('inventory.overview.export')}
          </Button>
          {actions}
        </div>
      </div>
      {active.length === 0 ? (
        <p className="text-muted-foreground">{t('inventory.page.noWarehouses')}</p>
      ) : (
        <>
          <Card className="grid gap-3 p-4 sm:grid-cols-3" data-testid="overview-filters">
            <Select
              aria-label={t('inventory.fields.category')}
              value={open ? selectionKey(open) : ''}
              onChange={(e) => {
                const key = e.target.value;
                setOpen(key === '' ? null : selectionOf(key));
              }}
              data-testid="overview-category"
            >
              <option value="">{t('inventory.overview.allCategories')}</option>
              {categories
                .filter((c) => c.archivedAt === null)
                .sort((a, b) =>
                  categoryPath(categories, a.id).localeCompare(categoryPath(categories, b.id)),
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryPath(categories, c.id)}
                  </option>
                ))}
              <option value="none">{t('inventory.page.uncategorized')}</option>
            </Select>
            <Select
              aria-label={t('inventory.overview.stockState')}
              value={stockState}
              onChange={(e) => setStockState(e.target.value as StockState)}
              data-testid="overview-stock"
            >
              <option value="all">{t('inventory.overview.allStock')}</option>
              <option value="low">{t('inventory.overview.lowStock')}</option>
              <option value="out">{t('inventory.overview.outOfStock')}</option>
            </Select>
            <Select
              aria-label={t('inventory.fields.warehouse')}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              data-testid="overview-warehouse"
            >
              <option value="">{t('inventory.page.allWarehouses')}</option>
              {active.map((w) => (
                <option key={w.id} value={w.id}>
                  {warehouseLabel(data, w)}
                </option>
              ))}
            </Select>
          </Card>

          <Loaded resource={stock} reload={reload}>
            {() => {
              if (open) {
                return (
                  <CategoryItems
                    shop={branchShop}
                    selection={open}
                    categories={categories}
                    rows={listed}
                    total={
                      prices
                        ? sumDecimals(
                            listed.map((r) => r.value ?? '0'),
                            2,
                          )
                        : null
                    }
                    query={query}
                    onQuery={setQuery}
                    onOpen={setOpen}
                    money={money}
                    searchId={`${id}-search`}
                  />
                );
              }
              const tiles = categoryTiles(rows, categories).filter(
                (tile) =>
                  needle === '' ||
                  tile.selection.kind === 'all' ||
                  (tile.category?.name.toLowerCase().includes(needle) ?? false),
              );
              const found = needle === '' ? [] : listed;
              return (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                      {t('inventory.overview.categories')}
                    </h2>
                    <SearchBox
                      id={`${id}-search`}
                      value={query}
                      onChange={setQuery}
                      placeholder={t('inventory.overview.search')}
                    />
                  </div>
                  <ul
                    className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
                    data-testid="category-tiles"
                  >
                    {tiles.map((tile) => (
                      <li key={selectionKey(tile.selection) || 'all'}>
                        <Tile tile={tile} onOpen={() => setOpen(tile.selection)} />
                      </li>
                    ))}
                  </ul>
                  {found.length > 0 && (
                    <section className="flex flex-col gap-2" data-testid="overview-found">
                      <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                        {t('inventory.overview.products')}
                      </h2>
                      <ItemTable
                        rows={found}
                        categories={categories}
                        money={money}
                        prices={prices}
                      />
                    </section>
                  )}
                </div>
              );
            }}
          </Loaded>
        </>
      )}
    </div>
  );
}

function SearchBox({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full sm:w-80">
      <Search
        aria-hidden
        className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        id={id}
        type="search"
        className="pl-9"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid="overview-search"
      />
    </div>
  );
}

/** A category tile: its image, or its colour; All items is white, Uncategorized grey. */
function Tile({ tile, onOpen }: { tile: CategoryTile; onOpen: () => void }) {
  const t = useT();
  const { store } = useAuth();
  const image = useCategoryImage(store, tile.category);
  const name =
    tile.selection.kind === 'all'
      ? t('inventory.overview.allItems')
      : tile.selection.kind === 'none'
        ? t('inventory.page.uncategorized')
        : (tile.category?.name ?? '');
  const plain = tile.selection.kind !== 'category';
  const background =
    tile.category && !image
      ? categoryColor(tile.category.id)
      : plain
        ? undefined
        : 'var(--table-slate)';
  const Icon = tile.selection.kind === 'all' ? LayoutGrid : Package;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'relative flex aspect-[4/3] w-full flex-col justify-between overflow-hidden rounded-xl border p-3 text-left transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:p-4',
        plain ? 'bg-card text-foreground' : 'border-transparent text-card',
        tile.selection.kind === 'none' && 'bg-muted',
      )}
      style={background ? { backgroundColor: background } : undefined}
      data-testid="category-tile"
      data-name={name}
    >
      {image && (
        <>
          {/* An object URL read through the api: next/image can't optimize it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt="" className="absolute inset-0 size-full object-cover" />
          <span
            aria-hidden
            className="absolute inset-0 bg-linear-to-t from-foreground/70 via-foreground/10 to-transparent"
          />
        </>
      )}
      <span
        aria-hidden
        className={cn(
          'relative flex size-8 items-center justify-center rounded-full',
          plain ? 'bg-muted text-muted-foreground' : 'bg-card/90 text-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="relative flex flex-col">
        <span className="truncate text-sm font-semibold sm:text-base">{name}</span>
        <span
          className={cn('text-xs', plain ? 'text-muted-foreground' : 'text-card/80')}
          data-testid="category-tile-count"
        >
          {t('inventory.overview.itemCount', { count: String(tile.count) })}
        </span>
      </span>
    </button>
  );
}

/** A category opened: its secondary categories as chips, then its items with their stock. */
function CategoryItems({
  shop,
  selection,
  categories,
  rows,
  total,
  query,
  onQuery,
  onOpen,
  money,
  searchId,
}: {
  shop: boolean;
  selection: CategorySelection;
  categories: readonly ProductCategory[];
  rows: ItemRow[];
  /** The value of what is listed; null without prices (ADR 0060). */
  total: string | null;
  query: string;
  onQuery: (value: string) => void;
  onOpen: (selection: CategorySelection | null) => void;
  money: (amount: string) => string;
  searchId: string;
}) {
  const t = useT();
  const category =
    selection.kind === 'category' ? categories.find((c) => c.id === selection.id) : undefined;
  // A secondary category's chips are its parent's, with itself picked.
  const top = category?.parentId ? categories.find((c) => c.id === category.parentId) : category;
  const chips = top ? secondaryCategories(categories, top.id) : [];
  const title =
    selection.kind === 'all'
      ? t('inventory.overview.allItems')
      : selection.kind === 'none'
        ? t('inventory.page.uncategorized')
        : categoryPath(categories, selection.id);
  return (
    <div className="flex flex-col gap-4" data-testid="overview-category-items">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          onClick={() => onOpen(null)}
          data-testid="overview-back"
          aria-label={t('inventory.overview.backToCategories')}
        >
          <ArrowLeft aria-hidden />
          <span className="hidden sm:inline">{t('inventory.overview.categories')}</span>
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h2>
        <SearchBox
          id={searchId}
          value={query}
          onChange={onQuery}
          placeholder={t('inventory.overview.searchItems')}
        />
      </div>
      {top && chips.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="overview-chips">
          <Button
            variant={category?.id === top.id ? 'default' : 'outline'}
            onClick={() => onOpen({ kind: 'category', id: top.id })}
          >
            {t('inventory.overview.allIn', { name: top.name })}
          </Button>
          {chips.map((chip) => (
            <Button
              key={chip.id}
              variant={category?.id === chip.id ? 'default' : 'outline'}
              onClick={() => onOpen({ kind: 'category', id: chip.id })}
              data-testid="overview-chip"
            >
              {chip.name}
            </Button>
          ))}
        </div>
      )}
      {shop ? (
        <BranchShop itemIds={rows.map((r) => r.item.id)} />
      ) : rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <Boxes aria-hidden className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">{t('inventory.overview.empty')}</p>
        </Card>
      ) : (
        <>
          {total !== null && (
            <p className="font-semibold" data-testid="overview-total">
              {t('inventory.page.totalValue', { value: money(total) })}
            </p>
          )}
          <ItemTable rows={rows} categories={categories} money={money} prices={total !== null} />
        </>
      )}
    </div>
  );
}

function ItemTable({
  rows,
  categories,
  money,
  prices,
}: {
  rows: readonly ItemRow[];
  categories: readonly ProductCategory[];
  money: (amount: string) => string;
  /** With the value column (ADR 0060). */
  prices: boolean;
}) {
  const t = useT();
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="hidden bg-muted text-left text-muted-foreground md:table-header-group">
          <tr>
            <th className="px-4 py-2 font-medium">{t('inventory.fields.item')}</th>
            <th className="px-4 py-2 font-medium">{t('inventory.fields.category')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('inventory.fields.quantity')}</th>
            <th className="px-4 py-2 font-medium">{t('inventory.fields.expiresOn')}</th>
            {prices && (
              <th className="px-4 py-2 text-right font-medium">{t('inventory.fields.value')}</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr
              key={row.item.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 md:table-row md:p-0"
              data-testid="overview-row"
              data-name={row.item.name}
            >
              <td className="w-full font-medium md:w-auto md:px-4 md:py-2">
                <span className="flex flex-wrap items-center gap-2">
                  {row.item.name}
                  {row.item.sku && (
                    <span className="text-xs font-normal text-muted-foreground">
                      {row.item.sku}
                    </span>
                  )}
                  {row.low && (
                    <Badge className="bg-accent text-accent-foreground" data-testid="overview-low">
                      {t('inventory.page.low')}
                    </Badge>
                  )}
                </span>
              </td>
              <td className="w-full text-muted-foreground md:w-auto md:px-4 md:py-2">
                {categoryPath(categories, row.item.categoryId) || t('inventory.page.uncategorized')}
              </td>
              <td
                className={cn(
                  'tabular-nums md:px-4 md:py-2 md:text-right',
                  row.quantity.startsWith('-') && 'text-destructive',
                )}
                data-testid="overview-quantity"
              >
                {`${shortQuantity(row.quantity)} ${t(`inventory.units.${row.item.unit}`)}`}
              </td>
              <td className="text-sm md:px-4 md:py-2">
                <ExpiryDate value={row.expiresOn} testId="overview-expiry" />
              </td>
              {prices && row.value !== null && (
                <td className="ml-auto font-medium tabular-nums md:px-4 md:py-2 md:text-right">
                  {money(row.value)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
