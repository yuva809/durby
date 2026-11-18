'use client';

import type { ProductCategory } from '@durby/shared';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, LayoutGrid, Search } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadCategories, loadProducts, orderCategories } from '../../lib/catalog/api';
import { categoryColor, useCategoryImage } from '../../lib/catalog/category-image';
import { loadStockItems } from '../../lib/inventory/api';
import { inOrder } from '../../lib/catalog/menu-order';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Loaded, NoAccess } from '../users/common';
import { ArchiveCategory } from './catalog-page';
import { CategoryDialog } from './category-dialog';

/**
 * /catalog/categories: the product categories on their own page (ADR 0044, the operations menu's
 * Product Category). Same api and rules as the categories column of /catalog: reading needs
 * `catalog.products.read`, changing `catalog.products.edit`; drag and drop sets the order of the top-level
 * categories. ADR 0048: each shows its tile image or colour and description, secondary categories sit under their
 * parent, and an organization without the till counts its stock items (with the till: menu products).
 */
export function CategoriesPage() {
  const { session } = useAuth();
  if (!session) return null;
  const permissions = new Set(session.activePermissions);
  if (!permissions.has('catalog.products.read'))
    return <NoAccess title="platform.nav.productCategories" />;
  return (
    <Categories
      organizationId={session.activeOrganizationId}
      canManage={permissions.has('catalog.products.edit')}
    />
  );
}

function Categories({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const t = useT();
  const { store, session } = useAuth();
  const id = useId();
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const withTill = session?.activeFeatures.includes('pos') ?? false;
  const countsItems =
    !withTill &&
    (session?.activeFeatures.includes('inventory') ?? false) &&
    (session?.activePermissions.includes('inventory.stock.read') ?? false);
  const [items, reloadItems] = useResource(countsItems ? organizationId : null, () =>
    loadStockItems(store),
  );
  const key = organizationId === null ? null : `${organizationId}:${showArchived}`;
  const [categories, reloadCategories] = useResource(key, () =>
    loadCategories(store, showArchived),
  );
  const [products, reloadProducts] = useResource(organizationId, () => loadProducts(store));
  const reload = () => {
    reloadCategories();
    reloadProducts();
    if (countsItems) reloadItems();
  };
  const orderAction = useActionKey();
  const [order, setOrder] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const canReorder = canManage && !showArchived;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Active stock items (no till) or menu products per category.
  const counts = new Map<string, number>();
  if (countsItems && items.status === 'ready') {
    for (const i of items.data) {
      if (i.archivedAt === null && i.categoryId) {
        counts.set(i.categoryId, (counts.get(i.categoryId) ?? 0) + 1);
      }
    }
  } else if (!countsItems && products.status === 'ready') {
    for (const p of products.data) {
      if (p.archivedAt === null) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
    }
  }
  const nameOf = (value: string | number) =>
    categories.status === 'ready'
      ? (categories.data.find((c) => c.id === String(value))?.name ?? '')
      : '';
  const onDrop = ({ active, over }: DragEndEvent, topLevel: ProductCategory[]) => {
    if (!over || active.id === over.id) return;
    // Only top-level categories move; secondary ones keep their order under their parent.
    const ids = topLevel.map((c) => c.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setOrder(next);
    setProblem(null);
    void orderCategories(store, orderAction, next).then((result) => {
      if (!result.ok) {
        setOrder(null);
        setProblem(t(errorLabel(result.code)));
        reloadCategories();
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('platform.nav.productCategories')}</h1>
          <p className="text-muted-foreground">{t('catalog.categoriesPage.intro')}</p>
        </div>
        {canManage && (
          <CategoryDialog
            categories={categories.status === 'ready' ? categories.data : []}
            onDone={reload}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search
            aria-hidden
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('catalog.categoriesPage.search')}
            aria-label={t('catalog.categoriesPage.search')}
            data-testid="categories-search"
          />
        </div>
        <div className="flex min-h-11 items-center gap-3">
          <Checkbox
            id={`${id}-archived`}
            checked={showArchived}
            onCheckedChange={(next) => setShowArchived(next === true)}
          />
          <Label htmlFor={`${id}-archived`} className="font-normal">
            {t('catalog.page.showArchived')}
          </Label>
        </div>
      </div>
      <Notice text={problem} tone="error" />
      <Loaded resource={categories} reload={reloadCategories}>
        {(loaded) => {
          const ordered = inOrder(loaded, order);
          // Top-level categories in order, each followed by its secondary ones (by position, then name).
          const known = new Set(ordered.map((c) => c.id));
          const topLevel = ordered.filter((c) => c.parentId === null || !known.has(c.parentId));
          const childrenOf = (parent: string) =>
            ordered
              .filter((c) => c.parentId === parent)
              .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
          const needle = query.trim().toLowerCase();
          const hit = (c: ProductCategory) =>
            needle === '' || c.name.toLowerCase().includes(needle);
          const lines = topLevel.flatMap((parent) => {
            const children = childrenOf(parent.id).filter(hit);
            return hit(parent) || children.length > 0
              ? [
                  { category: parent, child: false },
                  ...children.map((c) => ({ category: c, child: true })),
                ]
              : [];
          });
          const list = lines.map((l) => l.category);
          const canDrag = canReorder && needle === '';
          if (list.length === 0)
            return (
              <Card
                className="flex flex-col items-center gap-2 px-6 py-12 text-center"
                data-testid="categories-empty"
              >
                <LayoutGrid aria-hidden className="size-8 text-muted-foreground" />
                <p className="max-w-sm text-muted-foreground">
                  {t(canManage ? 'catalog.page.noCategoryHint' : 'catalog.page.emptyCategories')}
                </p>
              </Card>
            );
          return (
            <Card className="max-w-3xl p-0">
              {canDrag && topLevel.length > 1 && (
                <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                  {t('catalog.page.dragHint')}
                </p>
              )}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => onDrop(event, topLevel)}
                accessibility={{
                  screenReaderInstructions: { draggable: t('catalog.scan.dnd.instructions') },
                  announcements: {
                    onDragStart: ({ active }) =>
                      t('catalog.scan.dnd.picked', { name: nameOf(active.id) }),
                    onDragOver: ({ active, over }) =>
                      over
                        ? t('catalog.scan.dnd.over', {
                            name: nameOf(active.id),
                            target: nameOf(over.id),
                          })
                        : undefined,
                    onDragEnd: ({ active, over }) =>
                      over
                        ? t('catalog.scan.dnd.dropped', {
                            name: nameOf(active.id),
                            target: nameOf(over.id),
                          })
                        : undefined,
                    onDragCancel: ({ active }) =>
                      t('catalog.scan.dnd.cancelled', { name: nameOf(active.id) }),
                  },
                }}
              >
                <SortableContext
                  items={topLevel.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                  disabled={!canDrag}
                >
                  <ul className="divide-y divide-border" data-testid="category-list">
                    {lines.map(({ category, child }) => (
                      <CategoryLine
                        key={category.id}
                        category={category}
                        child={child}
                        count={counts.get(category.id) ?? 0}
                        countsItems={countsItems}
                        withTill={withTill}
                        categories={loaded}
                        canManage={canManage}
                        draggable={canDrag && !child}
                        onDone={reload}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            </Card>
          );
        }}
      </Loaded>
    </div>
  );
}

function CategoryLine({
  category,
  child,
  count,
  countsItems,
  withTill,
  categories,
  canManage,
  draggable,
  onDone,
}: {
  category: ProductCategory;
  /** A secondary category: indented under its parent, not dragged. */
  child: boolean;
  count: number;
  countsItems: boolean;
  withTill: boolean;
  categories: readonly ProductCategory[];
  canManage: boolean;
  draggable: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const image = useCategoryImage(store, category);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: category.id,
    disabled: !draggable,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex flex-wrap items-center gap-3 px-4 py-2',
        child && 'pl-10 sm:pl-16',
        isDragging && 'relative z-10 bg-card shadow-md',
      )}
      data-testid="category-line"
      data-name={category.name}
    >
      {draggable && (
        <button
          type="button"
          className="flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted active:cursor-grabbing"
          aria-label={t('catalog.page.dragCategory', { name: category.name })}
          data-testid="category-drag"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
      )}
      {!draggable && !child && <span aria-hidden className="w-11 shrink-0 max-sm:hidden" />}
      <span
        aria-hidden
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full',
          child ? 'size-8' : 'size-10',
        )}
        style={image ? undefined : { backgroundColor: categoryColor(category.id) }}
        data-testid="category-swatch"
      >
        {image && (
          // An object URL read through the api: next/image can't optimize it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="size-full object-cover" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{category.name}</span>
          {withTill && category.station === 'bar' && <Badge>{t('catalog.stations.bar')}</Badge>}
          {category.archivedAt && <Badge>{t('catalog.page.archived')}</Badge>}
        </span>
        {category.description && (
          <span
            className="truncate text-sm text-muted-foreground"
            data-testid="category-description-text"
          >
            {category.description}
          </span>
        )}
        <span className="text-sm text-muted-foreground" data-testid="category-count">
          {t(countsItems ? 'catalog.categoriesPage.items' : 'catalog.categoriesPage.products', {
            count: String(count),
          })}
        </span>
      </span>
      {canManage && (
        <span className="flex shrink-0 gap-2">
          <CategoryDialog category={category} categories={categories} onDone={onDone} />
          <ArchiveCategory category={category} onDone={onDone} />
        </span>
      )}
    </li>
  );
}
