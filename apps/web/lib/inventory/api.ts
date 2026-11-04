import {
  type AdjustmentRequest,
  type CreateStockItemRequest,
  type CreateWarehouseRequest,
  type DishCost,
  dishCostListResponseSchema,
  type PutRecipeRequest,
  type ReceiptRequest,
  type Recipe,
  recipeSchema,
  type StockDocument,
  stockDocumentListResponseSchema,
  stockDocumentSchema,
  type StockDocumentSummary,
  type StockItem,
  stockItemListResponseSchema,
  stockItemSchema,
  type StockLevel,
  stockLevelListResponseSchema,
  type TransferRequest,
  type UpdateStockItemRequest,
  type UpdateWarehouseRequest,
  type Warehouse,
  warehouseListResponseSchema,
  warehouseSchema,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls of the inventory pages (docs/modules/inventory.md → Web), parsed with the shared schemas. */

const BASE = '/api/v1/inventory';
const query = (params: Record<string, string | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const loadWarehouses = (store: Api, includeArchived = false): Promise<Result<Warehouse[]>> =>
  read(store, `${BASE}/warehouses${query({ includeArchived })}`, list(warehouseListResponseSchema));

export const createWarehouse = (store: Api, action: ActionKey, body: CreateWarehouseRequest) =>
  write(store, action, `${BASE}/warehouses`, 'POST', body, warehouseSchema);

export const updateWarehouse = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateWarehouseRequest,
) => write(store, action, `${BASE}/warehouses/${id}`, 'PATCH', body, warehouseSchema);

export const loadStockItems = (store: Api, includeArchived = false): Promise<Result<StockItem[]>> =>
  read(store, `${BASE}/items${query({ includeArchived })}`, list(stockItemListResponseSchema));

export const createStockItem = (store: Api, action: ActionKey, body: CreateStockItemRequest) =>
  write(store, action, `${BASE}/items`, 'POST', body, stockItemSchema);

export const updateStockItem = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateStockItemRequest,
) => write(store, action, `${BASE}/items/${id}`, 'PATCH', body, stockItemSchema);

export const loadStock = (
  store: Api,
  filter: { locationId?: string; warehouseId?: string },
): Promise<Result<StockLevel[]>> =>
  read(store, `${BASE}/stock${query(filter)}`, list(stockLevelListResponseSchema));

export const loadDocuments = (
  store: Api,
  filter: { warehouseId?: string; kind?: string },
): Promise<Result<StockDocumentSummary[]>> =>
  read(store, `${BASE}/documents${query(filter)}`, list(stockDocumentListResponseSchema));

export const loadDocument = (store: Api, id: string): Promise<Result<StockDocument>> =>
  read(store, `${BASE}/documents/${id}`, stockDocumentSchema);

export const postReceipt = (store: Api, action: ActionKey, body: ReceiptRequest) =>
  write(store, action, `${BASE}/receipts`, 'POST', body, stockDocumentSchema);

export const postAdjustment = (store: Api, action: ActionKey, body: AdjustmentRequest) =>
  write(store, action, `${BASE}/adjustments`, 'POST', body, stockDocumentSchema);

export const postTransfer = (store: Api, action: ActionKey, body: TransferRequest) =>
  write(store, action, `${BASE}/transfers`, 'POST', body, stockDocumentSchema);

export const loadRecipe = (store: Api, productId: string): Promise<Result<Recipe>> =>
  read(store, `${BASE}/recipes/${productId}`, recipeSchema);

export const putRecipe = (store: Api, action: ActionKey, productId: string, body: PutRecipeRequest) =>
  write(store, action, `${BASE}/recipes/${productId}`, 'PUT', body, recipeSchema);

export const loadCosts = (store: Api): Promise<Result<DishCost[]>> =>
  read(store, `${BASE}/costs`, list(dishCostListResponseSchema));
