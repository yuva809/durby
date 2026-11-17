import type { PrepStation, ProductCategory } from '@durby/shared';
import { snapshot } from '../../platform/audit';

/** One shape for a category everywhere in catalog: what is read, answered and audited (ADR 0048). */
export const CATEGORY_SELECT = {
  id: true,
  name: true,
  sortOrder: true,
  station: true,
  description: true,
  parentId: true,
  archivedAt: true,
  image: { select: { updatedAt: true } },
} as const;

export type CategoryRow = {
  id: string;
  name: string;
  sortOrder: number;
  station: PrepStation;
  description: string | null;
  parentId: string | null;
  archivedAt: Date | null;
  image: { updatedAt: Date } | null;
};

export function categoryResponse(row: CategoryRow): ProductCategory {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    station: row.station,
    description: row.description,
    parentId: row.parentId,
    imageVersion: row.image ? String(row.image.updatedAt.getTime()) : null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** The description is free text and not in the allow-list, so snapshot() drops it (as for products). */
export function categorySnapshot(row: CategoryRow) {
  return snapshot('product_category', categoryResponse(row));
}
