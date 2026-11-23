import {
  type AdjustmentRequest,
  type Bom,
  bomListResponseSchema,
  bomSchema,
  type CreateUnitOfMeasureRequest,
  type CreateVariantAttributeRequest,
  type GenerateVariantsRequest,
  generateVariantsResponseSchema,
  type ProductionRequest,
  type PutBomRequest,
  type UnitOfMeasure,
  unitOfMeasureListResponseSchema,
  unitOfMeasureSchema,
  type UpdateUnitOfMeasureRequest,
  type UpdateVariantAttributeRequest,
  type VariantAttribute,
  variantAttributeListResponseSchema,
  variantAttributeSchema,
  type CreateStockItemRequest,
  type ItemMovements,
  itemMovementsSchema,
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
import { type ProductCategory, productCategoryListResponseSchema } from '@durby/shared';
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

/** Deletes an item that has never been stocked; one with stock history answers inventory.item_in_use. */
export const deleteStockItem = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `${BASE}/items/${id}`, 'DELETE');

export const loadStock = (
  store: Api,
  filter: { locationId?: string; warehouseId?: string },
): Promise<Result<StockLevel[]>> =>
  read(store, `${BASE}/stock${query(filter)}`, list(stockLevelListResponseSchema));

/** An item's activity (its ledger), newest first, in one warehouse or all the caller reads. */
export const loadItemMovements = (
  store: Api,
  itemId: string,
  filter: { warehouseId?: string },
): Promise<Result<ItemMovements>> =>
  read(store, `${BASE}/items/${itemId}/movements${query(filter)}`, itemMovementsSchema);

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

export const putRecipe = (
  store: Api,
  action: ActionKey,
  productId: string,
  body: PutRecipeRequest,
) => write(store, action, `${BASE}/recipes/${productId}`, 'PUT', body, recipeSchema);

export const loadCosts = (store: Api): Promise<Result<DishCost[]>> =>
  read(store, `${BASE}/costs`, list(dishCostListResponseSchema));

/**
 * The categories items are filed under, for everyone who reads stock (ADR 0059): a branch without the catalog. No
 * images: those are the catalog's, so the tiles show their colour.
 */
export const loadStockCategories = async (
  store: Api,
  includeArchived = false,
): Promise<Result<ProductCategory[]>> => {
  const result = await read(
    store,
    `${BASE}/categories${query({ includeArchived })}`,
    list(productCategoryListResponseSchema),
  );
  return result.ok
    ? { ok: true, data: result.data.map((c) => ({ ...c, imageVersion: null })) }
    : result;
};

// Step 5 (docs/modules/inventory.md → Step 5, ADR 0038).

export const loadUnits = (store: Api, includeArchived = false): Promise<Result<UnitOfMeasure[]>> =>
  read(store, `${BASE}/units${query({ includeArchived })}`, list(unitOfMeasureListResponseSchema));

export const createUnit = (store: Api, action: ActionKey, body: CreateUnitOfMeasureRequest) =>
  write(store, action, `${BASE}/units`, 'POST', body, unitOfMeasureSchema);

export const updateUnit = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateUnitOfMeasureRequest,
) => write(store, action, `${BASE}/units/${id}`, 'PATCH', body, unitOfMeasureSchema);

export const loadAttributes = (
  store: Api,
  includeArchived = false,
): Promise<Result<VariantAttribute[]>> =>
  read(
    store,
    `${BASE}/attributes${query({ includeArchived })}`,
    list(variantAttributeListResponseSchema),
  );

export const createAttribute = (
  store: Api,
  action: ActionKey,
  body: CreateVariantAttributeRequest,
) => write(store, action, `${BASE}/attributes`, 'POST', body, variantAttributeSchema);

export const updateAttribute = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateVariantAttributeRequest,
) => write(store, action, `${BASE}/attributes/${id}`, 'PATCH', body, variantAttributeSchema);

export const generateVariants = (
  store: Api,
  action: ActionKey,
  itemId: string,
  body: GenerateVariantsRequest,
) =>
  write(
    store,
    action,
    `${BASE}/items/${itemId}/variants`,
    'POST',
    body,
    generateVariantsResponseSchema,
  );

export const loadBoms = (store: Api): Promise<Result<Bom[]>> =>
  read(store, `${BASE}/boms`, list(bomListResponseSchema));

export const putBom = (store: Api, action: ActionKey, itemId: string, body: PutBomRequest) =>
  write(store, action, `${BASE}/boms/${itemId}`, 'PUT', body, bomSchema);

export const deleteBom = (store: Api, action: ActionKey, itemId: string) =>
  write(store, action, `${BASE}/boms/${itemId}`, 'DELETE');

export const postProduction = (store: Api, action: ActionKey, body: ProductionRequest) =>
  write(store, action, `${BASE}/productions`, 'POST', body, stockDocumentSchema);
