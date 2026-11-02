'use client';

import {
  checkImportRows,
  importRowKey,
  type ImportRowProblem,
  type Product,
  type ProductCategory,
} from '@durby/shared';
import {
  closestCenter,
  closestCorners,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { Eye, EyeOff, Plus, Redo2, Search, Trash2, Undo2, Upload, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useT } from '../../../app/labels-provider';
import {
  type Board,
  type BoardAction,
  type BoardCategory,
  type BoardProduct,
  type HistoryAction,
  toImportRows,
} from '../../../lib/catalog/menu-scan/board';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Select } from '../../ui/select';
import {
  CategoryColumn,
  categoryDndId,
  type Existing,
  LOW_CONFIDENCE,
  ProductCard,
} from './board-parts';
import { OriginalPane, type PagePreview } from './original-pane';

type Filter = 'all' | 'low' | 'problems';
type CategoryDialog = { kind: 'merge' | 'swap'; categoryId: string } | null;

const newId = () => crypto.randomUUID();

/** Products dragged collide with cards and column drop zones; columns only with columns. */
const collision: CollisionDetection = (args) => {
  const dragged = String(args.active.id);
  const kind = dragged.startsWith('cat:') ? 'cat:' : null;
  const droppableContainers = args.droppableContainers.filter((c) => {
    const id = String(c.id);
    return kind ? id.startsWith('cat:') : !id.startsWith('cat:');
  });
  return (kind ? closestCenter : closestCorners)({ ...args, droppableContainers });
};

/**
 * The scan's review board (docs/modules/catalog.md → Menu scan): category columns of product cards,
 * drag and drop (pointer, touch, keyboard), edits, undo/redo, problems from the import's own
 * checks, and the original pages beside it.
 */
export function ReviewBoard({
  board,
  canUndo,
  canRedo,
  dispatch,
  pages,
  catalog,
  importing,
  error,
  onImport,
  onDiscard,
}: {
  board: Board;
  canUndo: boolean;
  canRedo: boolean;
  dispatch: (action: HistoryAction) => void;
  pages: readonly PagePreview[];
  catalog: { categories: ProductCategory[]; products: Product[] } | null;
  importing: boolean;
  error: string | null;
  onImport: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(pages.length > 0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<CategoryDialog>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const boardDispatch = dispatch as (action: BoardAction) => void;

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y), outside text fields so typing keeps its own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) dispatch({ type: 'undo' });
      else if ((key === 'z' && e.shiftKey) || key === 'y') dispatch({ type: 'redo' });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  const rows = useMemo(() => toImportRows(board), [board]);
  /** Problems per product id: rows come in board order, so row n is the nth product. */
  const problems = useMemo(() => {
    const order = board.categories.flatMap((c) => c.productIds.filter((p) => board.products[p]));
    const byProduct = new Map<string, ImportRowProblem[]>();
    for (const problem of checkImportRows(rows)) {
      const productId = order[problem.row - 1];
      if (!productId) continue;
      byProduct.set(productId, [...(byProduct.get(productId) ?? []), problem]);
    }
    return byProduct;
  }, [board, rows]);
  const problemCount = [...problems.values()].reduce((n, list) => n + list.length, 0);

  const inCatalog = useMemo(() => {
    if (!catalog) return new Map<string, Product>();
    const categoryNames = new Map(catalog.categories.map((c) => [c.id, c.name]));
    return new Map(
      catalog.products.flatMap((p) => {
        const category = categoryNames.get(p.categoryId);
        return category ? [[importRowKey({ category, name: p.name }), p] as const] : [];
      }),
    );
  }, [catalog]);
  const existing = (category: string, product: BoardProduct): Existing => {
    const current = inCatalog.get(importRowKey({ category, name: product.name }));
    if (!current) return { kind: 'new' };
    return samePrice(current.price, product.price)
      ? { kind: 'same' }
      : { kind: 'update', price: current.price };
  };

  const productCount = rows.length;
  const lowCount = Object.values(board.products).filter(
    (p) => p.confidence < LOW_CONFIDENCE,
  ).length;
  const needle = query.trim().toLowerCase();
  const visible = (productId: string) => {
    const p = board.products[productId];
    if (!p) return false;
    if (needle && !`${p.name} ${p.description}`.toLowerCase().includes(needle)) return false;
    if (filter === 'low') return p.confidence < LOW_CONFIDENCE;
    if (filter === 'problems') return problems.has(productId);
    return true;
  };
  const categoryOf = (productId: string) =>
    board.categories.find((c) => c.productIds.includes(productId));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const nameOf = (dndId: string | number | undefined): string => {
    const [kind, ...rest] = String(dndId ?? '').split(':');
    const key = rest.join(':');
    if (kind === 'prod') return board.products[key]?.name ?? '';
    return board.categories.find((c) => c.id === key)?.name ?? '';
  };

  function onDragEnd({ active, over }: DragEndEvent) {
    setDragging(null);
    if (!over) return;
    const [kind, ...activeRest] = String(active.id).split(':');
    const activeKey = activeRest.join(':');
    const [overKind, ...overRest] = String(over.id).split(':');
    const overKey = overRest.join(':');
    if (kind === 'cat') {
      if (overKind !== 'cat' || overKey === activeKey) return;
      const index = board.categories.findIndex((c) => c.id === overKey);
      dispatch({ type: 'moveCategory', categoryId: activeKey, index });
      return;
    }
    if (overKind === 'prod') {
      if (overKey === activeKey) return;
      const target = categoryOf(overKey);
      if (!target) return;
      dispatch({
        type: 'moveProduct',
        productId: activeKey,
        toCategoryId: target.id,
        index: target.productIds.indexOf(overKey),
      });
      return;
    }
    // A column's drop zone or header: to the end of that category.
    const target = board.categories.find((c) => c.id === overKey);
    if (!target || target.productIds.at(-1) === activeKey) return;
    dispatch({
      type: 'moveProduct',
      productId: activeKey,
      toCategoryId: target.id,
      index: target.productIds.length,
    });
  }

  const draggedProduct = dragging?.startsWith('prod:') ? board.products[dragging.slice(5)] : null;
  const draggedCategory = draggedProduct ? categoryOf(draggedProduct.id) : undefined;
  // Products deleted (or undone away) drop out of the selection.
  const selection = [...selected].filter((p) => board.products[p]);

  function addCategory() {
    const category = { id: newId(), name: uniqueName(board, t('catalog.scan.newCategory')) };
    dispatch({ type: 'addCategory', category });
  }

  function addProduct(category: BoardCategory) {
    const productId = newId();
    dispatch({
      type: 'addProduct',
      categoryId: category.id,
      product: {
        id: productId,
        name: t('catalog.scan.newProduct'),
        price: '',
        description: '',
        taxRate: null,
        confidence: 100,
        source: null,
      },
    });
    setFocusedId(productId);
  }

  const toggle = (productId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });

  return (
    <div className="flex flex-col gap-3" data-testid="scan-board">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label={t('catalog.scan.search')}
              placeholder={t('catalog.scan.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div
            role="radiogroup"
            aria-label={t('catalog.scan.filter')}
            className="flex rounded-md border bg-muted p-0.5"
          >
            {(
              [
                ['all', 'catalog.scan.filterAll', productCount],
                ['low', 'catalog.scan.filterLow', lowCount],
                ['problems', 'catalog.scan.filterProblems', problems.size],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  'min-h-10 rounded px-3 text-sm',
                  filter === value ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground',
                )}
              >
                {t(label)} <span className="tabular-nums">{count}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label={t('catalog.scan.undo')}
              title={t('catalog.scan.undo')}
              disabled={!canUndo}
              onClick={() => dispatch({ type: 'undo' })}
              data-testid="scan-undo"
            >
              <Undo2 aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('catalog.scan.redo')}
              title={t('catalog.scan.redo')}
              disabled={!canRedo}
              onClick={() => dispatch({ type: 'redo' })}
            >
              <Redo2 aria-hidden />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <VatDefault
            id={`${id}-food`}
            label={t('catalog.scan.vatFood')}
            value={board.defaults.food}
            onChange={(food) =>
              dispatch({ type: 'setDefaults', food, drinks: board.defaults.drinks })
            }
          />
          <VatDefault
            id={`${id}-drinks`}
            label={t('catalog.scan.vatDrinks')}
            value={board.defaults.drinks}
            onChange={(drinks) =>
              dispatch({ type: 'setDefaults', food: board.defaults.food, drinks })
            }
          />
          <p className="text-sm text-muted-foreground" data-testid="scan-summary">
            {t('catalog.scan.summary', {
              products: String(productCount),
              categories: String(board.categories.length),
            })}
            {lowCount > 0 && <> · {t('catalog.scan.toCheck', { count: String(lowCount) })}</>}
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {pages.length > 0 && (
              <Button
                variant="ghost"
                className="hidden lg:inline-flex"
                aria-pressed={showOriginal}
                onClick={() => setShowOriginal((s) => !s)}
              >
                {showOriginal ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                {t(showOriginal ? 'catalog.scan.hideOriginal' : 'catalog.scan.showOriginal')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setDiscardOpen(true)} data-testid="scan-discard">
              {t('catalog.scan.discard')}
            </Button>
            <Button
              onClick={onImport}
              disabled={importing || productCount === 0 || problemCount > 0}
              data-testid="scan-import"
            >
              <Upload aria-hidden />
              {importing
                ? t('catalog.scan.importing')
                : t('catalog.scan.import', { count: String(productCount) })}
            </Button>
          </div>
        </div>
        {problemCount > 0 && (
          <p className="text-sm text-destructive" data-testid="scan-problems">
            {t('catalog.scan.problemsCount', { count: String(problemCount) })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {selection.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-2 rounded-md bg-accent px-3 py-2"
            data-testid="scan-selection"
          >
            <span className="text-sm font-medium">
              {t('catalog.scan.selected', { count: String(selection.length) })}
            </span>
            <Select
              aria-label={t('catalog.scan.moveTo')}
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                dispatch({
                  type: 'moveProducts',
                  productIds: selection,
                  toCategoryId: e.target.value,
                });
                setSelected(new Set());
              }}
              className="w-auto min-w-40"
              data-testid="scan-move-to"
            >
              <option value="">{t('catalog.scan.moveTo')}</option>
              {board.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              onClick={() => dispatch({ type: 'deleteProducts', productIds: selection })}
            >
              <Trash2 aria-hidden />
              {t('catalog.scan.deleteSelected')}
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              <X aria-hidden />
              {t('catalog.scan.clearSelection')}
            </Button>
          </div>
        )}
      </div>

      <div
        className={cn(
          'grid gap-3',
          showOriginal && pages.length > 0 && 'lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]',
        )}
      >
        {showOriginal && pages.length > 0 && (
          <aside
            className="hidden self-start rounded-xl border bg-card p-2 lg:sticky lg:top-40 lg:block lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto"
            aria-label={t('catalog.scan.original')}
          >
            <OriginalPane
              pages={pages}
              board={board}
              selectedId={focusedId}
              onSelect={(productId) => {
                setFocusedId(productId);
                document
                  .querySelector(`[data-product-id="${productId}"]`)
                  ?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
              }}
            />
          </aside>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={({ active }: DragStartEvent) => setDragging(String(active.id))}
          onDragCancel={() => setDragging(null)}
          onDragEnd={onDragEnd}
          accessibility={{
            screenReaderInstructions: { draggable: t('catalog.scan.dnd.instructions') },
            announcements: {
              onDragStart: ({ active }) =>
                t('catalog.scan.dnd.picked', { name: nameOf(active.id) }),
              onDragOver: ({ active, over }) =>
                over
                  ? t('catalog.scan.dnd.over', {
                      name: nameOf(active.id),
                      target: nameOf(targetId(over.id)),
                    })
                  : undefined,
              onDragEnd: ({ active, over }) =>
                over
                  ? t('catalog.scan.dnd.dropped', {
                      name: nameOf(active.id),
                      target: nameOf(targetId(over.id)),
                    })
                  : undefined,
              onDragCancel: ({ active }) =>
                t('catalog.scan.dnd.cancelled', { name: nameOf(active.id) }),
            },
          }}
        >
          <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:overflow-x-auto md:pb-3">
            <SortableContext
              items={board.categories.map((c) => categoryDndId(c.id))}
              strategy={horizontalListSortingStrategy}
            >
              {board.categories.map((category) => (
                <CategoryColumn
                  key={category.id}
                  category={category}
                  count={category.productIds.length}
                  onRename={(name) =>
                    boardDispatch({ type: 'renameCategory', categoryId: category.id, name })
                  }
                  onVat={(taxRate) =>
                    boardDispatch({ type: 'setCategoryVat', categoryId: category.id, taxRate })
                  }
                  onAddProduct={() => addProduct(category)}
                  onAction={(kind) => {
                    if (kind === 'delete') {
                      boardDispatch({
                        type: 'deleteCategory',
                        categoryId: category.id,
                        uncategorized: { id: newId(), name: t('catalog.scan.uncategorized') },
                      });
                    } else setCategoryDialog({ kind, categoryId: category.id });
                  }}
                >
                  {category.productIds.filter(visible).map((productId) => (
                    <ProductCard
                      key={productId}
                      product={board.products[productId]!}
                      category={category}
                      existing={existing(category.name, board.products[productId]!)}
                      problems={problems.get(productId) ?? []}
                      selected={selected.has(productId)}
                      focused={focusedId === productId}
                      dispatch={boardDispatch}
                      onToggle={() => toggle(productId)}
                      onFocus={() => setFocusedId(productId)}
                    />
                  ))}
                </CategoryColumn>
              ))}
            </SortableContext>
            <Button
              variant="outline"
              className="shrink-0 border-dashed md:w-56"
              onClick={addCategory}
              data-testid="scan-add-category"
            >
              <Plus aria-hidden />
              {t('catalog.scan.addCategory')}
            </Button>
          </div>
          <DragOverlay>
            {draggedProduct && draggedCategory ? (
              <ul className="w-72">
                <ProductCard
                  overlay
                  product={draggedProduct}
                  category={draggedCategory}
                  existing={existing(draggedCategory.name, draggedProduct)}
                  problems={problems.get(draggedProduct.id) ?? []}
                  selected={selected.has(draggedProduct.id)}
                  focused={false}
                  dispatch={() => undefined}
                  onToggle={() => undefined}
                  onFocus={() => undefined}
                />
              </ul>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <CategoryPicker
        dialog={categoryDialog}
        board={board}
        onClose={() => setCategoryDialog(null)}
        onApply={(dialog, target) => {
          if (dialog.kind === 'merge') {
            boardDispatch({ type: 'mergeCategory', from: dialog.categoryId, into: target });
          } else boardDispatch({ type: 'swapCategories', a: dialog.categoryId, b: target });
          setCategoryDialog(null);
        }}
      />

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent closeLabel={t('platform.common.close')}>
          <DialogTitle>{t('catalog.scan.discardTitle')}</DialogTitle>
          <DialogDescription>{t('catalog.scan.discardDescription')}</DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>
              {t('catalog.scan.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDiscardOpen(false);
                onDiscard();
              }}
              data-testid="scan-discard-confirm"
            >
              {t('catalog.scan.discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `drop:<id>` and `cat:<id>` both name the category for announcements. */
const targetId = (id: string | number) => String(id).replace(/^drop:/, 'cat:');

function VatDefault({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-9 w-16 text-center tabular-nums"
      />
    </div>
  );
}

function CategoryPicker({
  dialog,
  board,
  onClose,
  onApply,
}: {
  dialog: CategoryDialog;
  board: Board;
  onClose: () => void;
  onApply: (dialog: NonNullable<CategoryDialog>, target: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [target, setTarget] = useState('');
  const source = dialog ? board.categories.find((c) => c.id === dialog.categoryId) : undefined;
  const others = board.categories.filter((c) => c.id !== dialog?.categoryId);
  const value = others.some((c) => c.id === target) ? target : (others[0]?.id ?? '');

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t('platform.common.close')}>
        <DialogTitle>
          {t(dialog?.kind === 'swap' ? 'catalog.scan.swapTitle' : 'catalog.scan.mergeTitle', {
            name: source?.name ?? '',
          })}
        </DialogTitle>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-target`}>{t('catalog.scan.target')}</Label>
          <Select
            id={`${id}-target`}
            value={value}
            onChange={(e) => setTarget(e.target.value)}
            data-testid="scan-target"
          >
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('catalog.scan.cancel')}
          </Button>
          <Button
            disabled={!dialog || !value}
            onClick={() => dialog && value && onApply(dialog, value)}
            data-testid="scan-apply"
          >
            {t('catalog.scan.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function uniqueName(board: Board, base: string): string {
  const taken = new Set(board.categories.map((c) => c.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Decimal texts compared without number math: `12.5` and `12.50` are the same price. */
function samePrice(a: string, b: string): boolean {
  const norm = (s: string) => {
    const [whole = '', fraction = ''] = s.trim().split('.');
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
  };
  return norm(a) === norm(b);
}
