'use client';

import type { ImportRowProblem } from '@durby/shared';
import type { LabelKey } from '@durby/i18n';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertTriangle,
  Check,
  GripVertical,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../../app/labels-provider';
import {
  type BoardAction,
  type BoardCategory,
  type BoardProduct,
  needsCheck,
} from '../../../lib/catalog/menu-scan/board';
import type { Suggestion } from '../../../lib/catalog/menu-scan/suggest';
import { cn } from '../../../lib/utils';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { Input } from '../../ui/input';
import { useMoney } from '../../pos/money';

export const productDndId = (id: string) => `prod:${id}`;
export const categoryDndId = (id: string) => `cat:${id}`;
export const dropDndId = (id: string) => `drop:${id}`;

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

/** One suggestion: what it would change, Apply and Dismiss. */
export function SuggestionChip({
  suggestion,
  onApply,
  onDismiss,
}: {
  suggestion: Suggestion;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const money = useMoney();
  const text = (() => {
    switch (suggestion.kind) {
      case 'name':
        return suggestion.fromCatalog
          ? t('catalog.scan.suggest.existing', { name: suggestion.name })
          : t('catalog.scan.suggest.name', { name: suggestion.name });
      case 'price':
        return t('catalog.scan.suggest.price', { price: money(suggestion.price) });
      case 'move':
        return t('catalog.scan.suggest.move', { category: suggestion.categoryName });
      case 'rename':
        return t('catalog.scan.suggest.rename', { name: suggestion.name });
    }
  })();
  return (
    <div
      className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 py-0.5 pr-0.5 pl-2 text-xs"
      data-testid="scan-suggestion"
      data-kind={suggestion.kind}
    >
      <Sparkles aria-hidden className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 break-words">{text}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={t('catalog.scan.apply')}
        title={t('catalog.scan.apply')}
        onClick={(e) => {
          e.stopPropagation();
          onApply();
        }}
        data-testid="scan-suggestion-apply"
      >
        <Check aria-hidden className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={t('catalog.scan.suggest.dismiss')}
        title={t('catalog.scan.suggest.dismiss')}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        <X aria-hidden className="size-4" />
      </Button>
    </div>
  );
}

/** How the product relates to the current catalog (the import's matching rule). */
export type Existing = { kind: 'new' } | { kind: 'update'; price: string } | { kind: 'same' };

export function ProductCard({
  product,
  category,
  existing,
  problems,
  selected,
  focused,
  dispatch,
  onToggle,
  onFocus,
  suggestions = [],
  onApply,
  onDismiss,
  overlay = false,
}: {
  product: BoardProduct;
  category: BoardCategory;
  existing: Existing;
  problems: ImportRowProblem[];
  selected: boolean;
  focused: boolean;
  dispatch: (action: BoardAction) => void;
  onToggle: () => void;
  onFocus: () => void;
  suggestions?: Suggestion[];
  onApply?: (suggestion: Suggestion) => void;
  onDismiss?: (suggestion: Suggestion) => void;
  overlay?: boolean;
}) {
  const t = useT();
  const money = useMoney();
  const id = useId();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: productDndId(product.id),
    disabled: overlay,
  });
  const low = needsCheck(product);
  const update = (patch: Partial<Omit<BoardProduct, 'id'>>) =>
    dispatch({ type: 'updateProduct', productId: product.id, patch });
  const invalid = (field: ImportRowProblem['field']) => problems.some((p) => p.field === field);

  return (
    <li
      ref={overlay ? undefined : setNodeRef}
      style={
        overlay
          ? undefined
          : {
              transform: CSS.Translate.toString(transform),
              transition: transition,
            }
      }
      className={cn(
        'list-none rounded-lg border bg-card p-2.5 shadow-sm',
        isDragging && 'opacity-40',
        overlay && 'rotate-1 shadow-lg',
        focused && 'ring-2 ring-primary',
        problems.length > 0 && 'border-destructive',
        low && problems.length === 0 && 'border-[var(--table-amber)] bg-[var(--table-amber-soft)]',
      )}
      onFocusCapture={onFocus}
      onClick={onFocus}
      data-testid="scan-product"
      data-product-id={product.id}
      data-name={product.name}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          className="mt-1.5 cursor-grab touch-none rounded text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label={t('catalog.scan.dragProduct', { name: product.name })}
          {...(overlay ? {} : { ...attributes, ...listeners })}
          data-testid="scan-product-handle"
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
        <Checkbox
          className="mt-2"
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={t('catalog.scan.select', { name: product.name })}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Input
            aria-label={t('catalog.scan.productName')}
            aria-invalid={invalid('name') || undefined}
            value={product.name}
            onChange={(e) => update({ name: e.target.value })}
            className="min-h-9 font-medium"
            data-testid="scan-product-name"
          />
          <div className="flex gap-1.5">
            <Input
              aria-label={t('catalog.scan.productPrice')}
              aria-invalid={invalid('price') || undefined}
              inputMode="decimal"
              value={product.price}
              onChange={(e) => update({ price: e.target.value.replace(',', '.') })}
              className="min-h-9 w-24 tabular-nums"
              data-testid="scan-product-price"
            />
            <Input
              aria-label={t('catalog.scan.productVat')}
              aria-invalid={invalid('taxRate') || undefined}
              inputMode="decimal"
              placeholder={t('catalog.scan.categoryRate', { rate: category.taxRate })}
              value={product.taxRate ?? ''}
              onChange={(e) => update({ taxRate: e.target.value === '' ? null : e.target.value })}
              className="min-h-9 min-w-0 flex-1 text-sm"
            />
          </div>
          <Input
            aria-label={t('catalog.scan.productDescription')}
            placeholder={t('catalog.scan.productDescription')}
            value={product.description}
            onChange={(e) => update({ description: e.target.value })}
            className="min-h-8 text-xs"
          />
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {existing.kind === 'new' && <Badge>{t('catalog.scan.badgeNew')}</Badge>}
            {existing.kind === 'update' && (
              <Badge className="border-primary text-foreground">
                {t('catalog.scan.badgeUpdate', { price: money(existing.price) })}
              </Badge>
            )}
            {existing.kind === 'same' && <Badge>{t('catalog.scan.badgeSame')}</Badge>}
            {low && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-[var(--table-amber)] px-1.5 py-0.5 font-medium"
                id={`${id}-low`}
                title={t('catalog.scan.lowConfidence', { confidence: String(product.confidence) })}
              >
                <AlertTriangle aria-hidden className="size-3" />
                {t('catalog.scan.confidence', { confidence: String(product.confidence) })}
                <span className="sr-only">
                  {t('catalog.scan.lowConfidence', { confidence: String(product.confidence) })}
                </span>
              </span>
            )}
          </div>
          {!overlay && suggestions.length > 0 && (
            <div className="flex flex-col gap-1">
              {suggestions.map((suggestion) => (
                <SuggestionChip
                  key={suggestion.key}
                  suggestion={suggestion}
                  onApply={() => onApply?.(suggestion)}
                  onDismiss={() => onDismiss?.(suggestion)}
                />
              ))}
            </div>
          )}
          {problems.length > 0 && (
            <ul className="text-xs text-destructive" role="alert">
              {problems.map((p) => (
                <li key={`${p.field}-${p.problem}`}>
                  {t(FIELD_LABEL[p.field])}: {t(PROBLEM_LABEL[p.problem])}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          aria-label={t('catalog.scan.deleteProduct', { name: product.name })}
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: 'deleteProducts', productIds: [product.id] });
          }}
        >
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </div>
    </li>
  );
}

/** A category as a board column: sortable itself, a drop zone and a sortable list of products. */
export function CategoryColumn({
  category,
  count,
  onRename,
  onVat,
  onAddProduct,
  onAction,
  suggestions = [],
  onApply,
  onDismiss,
  children,
}: {
  category: BoardCategory;
  count: number;
  onRename: (name: string) => void;
  onVat: (taxRate: string) => void;
  onAddProduct: () => void;
  onAction: (action: 'merge' | 'swap' | 'delete') => void;
  suggestions?: Suggestion[];
  onApply?: (suggestion: Suggestion) => void;
  onDismiss?: (suggestion: Suggestion) => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: categoryDndId(category.id),
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: dropDndId(category.id) });
  const [name, setName] = useState(category.name);
  const [editing, setEditing] = useState(false);
  const commit = () => {
    setEditing(false);
    const next = name.trim();
    if (next && next !== category.name) onRename(next);
    else setName(category.name);
  };

  return (
    <section
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: transition,
      }}
      className={cn(
        'flex w-full shrink-0 flex-col rounded-xl border bg-muted/60 md:w-80',
        isDragging && 'opacity-50',
      )}
      aria-label={category.name}
      data-testid="scan-category"
      data-name={category.name}
    >
      <header className="flex items-center gap-1 border-b p-2">
        <button
          type="button"
          className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground"
          aria-label={t('catalog.scan.dragCategory', { name: category.name })}
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
        {editing ? (
          <Input
            autoFocus
            aria-label={t('catalog.scan.categoryName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setName(category.name);
                setEditing(false);
              }
            }}
            className="min-h-9 flex-1 font-semibold"
            data-testid="scan-category-name"
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate rounded px-1 py-1.5 text-left font-semibold hover:bg-card"
            onClick={() => {
              setName(category.name);
              setEditing(true);
            }}
            data-testid="scan-category-title"
          >
            {category.name}
          </button>
        )}
        <Badge>{count}</Badge>
        <Input
          aria-label={t('catalog.scan.categoryVat', { name: category.name })}
          inputMode="decimal"
          value={category.taxRate}
          onChange={(e) => onVat(e.target.value)}
          className="min-h-9 w-14 px-1.5 text-center text-sm tabular-nums"
          data-testid="scan-category-vat"
        />
        <span aria-hidden className="text-xs text-muted-foreground">
          %
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              aria-label={t('catalog.scan.categoryMenu', { name: category.name })}
              data-testid="scan-category-menu"
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAction('merge')}>
              {t('catalog.scan.mergeInto')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('swap')}>
              {t('catalog.scan.swapWith')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onAction('delete')}
              data-testid="scan-category-delete"
            >
              <Trash2 aria-hidden />
              {t('catalog.scan.deleteCategory')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {(category.suspect || suggestions.length > 0) && (
        <div className="flex flex-col gap-1 border-b px-2 py-1.5">
          {category.suspect && (
            <p className="flex items-center gap-1 text-xs" data-testid="scan-check-heading">
              <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
              {t('catalog.scan.checkHeading')}
            </p>
          )}
          {suggestions.map((suggestion) => (
            <SuggestionChip
              key={suggestion.key}
              suggestion={suggestion}
              onApply={() => onApply?.(suggestion)}
              onDismiss={() => onDismiss?.(suggestion)}
            />
          ))}
        </div>
      )}
      <div
        ref={setDropRef}
        className={cn('flex min-h-24 flex-1 flex-col p-2', isOver && 'bg-ring/10')}
      >
        <SortableContext
          items={category.productIds.map(productDndId)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-2">{children}</ul>
        </SortableContext>
        {count === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('catalog.scan.emptyColumn')}
          </p>
        )}
        <Button variant="ghost" className="mt-2 justify-start" onClick={onAddProduct}>
          <Plus aria-hidden />
          {t('catalog.scan.addProduct')}
        </Button>
      </div>
    </section>
  );
}
