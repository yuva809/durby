import { dataImportResultSchema, type ImportKind } from '@durby/shared';
import { type Api, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Where each kind is imported (docs/platform/import.md): the module that owns the records. */
export const IMPORT_PATHS: Readonly<Record<ImportKind, string>> = {
  categories: '/api/v1/catalog/categories/import',
  items: '/api/v1/inventory/items/import',
  opening_stock: '/api/v1/inventory/opening-stock/import',
  customers: '/api/v1/orders/customers/import',
};

export const runImport = (
  store: Api,
  action: ActionKey,
  kind: ImportKind,
  rows: readonly Record<string, string>[],
) => write(store, action, IMPORT_PATHS[kind], 'POST', { rows }, dataImportResultSchema);
