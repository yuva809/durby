import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  type AdjustmentRequest,
  adjustmentRequestSchema,
  type CreateStockItemRequest,
  createStockItemRequestSchema,
  type CreateWarehouseRequest,
  createWarehouseRequestSchema,
  type ListProductCategoriesQuery,
  listProductCategoriesQuerySchema,
  type ProductCategoryListResponse,
  type ListStockDocumentsQuery,
  listStockDocumentsQuerySchema,
  type ListStockItemsQuery,
  listStockItemsQuerySchema,
  type ListWarehousesQuery,
  listWarehousesQuerySchema,
  type PutRecipeRequest,
  putRecipeRequestSchema,
  type Recipe,
  type ReceiptRequest,
  receiptRequestSchema,
  type StockDocument,
  type StockItem,
  type StockQuery,
  stockQuerySchema,
  type TransferRequest,
  transferRequestSchema,
  type UpdateStockItemRequest,
  updateStockItemRequestSchema,
  type UpdateWarehouseRequest,
  updateWarehouseRequestSchema,
  type Warehouse,
  type DataImportResult,
  type ImportItemsRequest,
  importItemsRequestSchema,
  type ImportOpeningStockRequest,
  importOpeningStockRequestSchema,
  type ItemMovements,
} from '@durby/shared';
import { CatalogService } from '../catalog';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { inventoryErrors } from './inventory-errors';
import { RecipesService } from './recipes.service';
import { InventorySetupService } from './setup.service';
import { ItemImportService } from './item-import.service';
import { StockService } from './stock.service';

const id = (notFound: () => Error) => new ParseUUIDPipe({ exceptionFactory: notFound });

/**
 * /api/v1/inventory (docs/modules/inventory.md). The guard checks each key for some location; the
 * services check it at the warehouse's location. Creates and stock documents append rows, so they
 * complete their idempotency key in the business transaction (rule 8).
 */
@RequireFeature('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly setup: InventorySetupService,
    private readonly stockService: StockService,
    private readonly recipes: RecipesService,
    private readonly itemImport: ItemImportService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * The categories items are filed under (ADR 0059), for everyone who reads stock: a branch sees its stock by
   * category without reading the catalog and its prices. Names and order only; the same list as the catalog's.
   */
  @RequirePermission('inventory.stock.read')
  @Get('categories')
  async categories(
    @Query(new ZodQuery(listProductCategoriesQuerySchema)) query: ListProductCategoriesQuery,
  ): Promise<ProductCategoryListResponse> {
    return { data: await this.catalog.listCategories(query) };
  }

  @RequirePermission('inventory.stock.read')
  @Get('warehouses')
  async warehouses(
    @Query(new ZodQuery(listWarehousesQuerySchema)) query: ListWarehousesQuery,
  ): Promise<{ data: Warehouse[] }> {
    return { data: await this.setup.listWarehouses(query) };
  }

  @RequirePermission('inventory.warehouses.create')
  @Idempotent({ completion: 'transaction' })
  @Post('warehouses')
  createWarehouse(
    @Body(new ZodBody(createWarehouseRequestSchema)) body: CreateWarehouseRequest,
  ): Promise<Warehouse> {
    return this.setup.createWarehouse(body);
  }

  @RequirePermission('inventory.warehouses.edit')
  @Idempotent()
  @Patch('warehouses/:id')
  updateWarehouse(
    @Param('id', id(inventoryErrors.warehouseNotFound)) warehouseId: string,
    @Body(new ZodBody(updateWarehouseRequestSchema)) body: UpdateWarehouseRequest,
  ): Promise<Warehouse> {
    return this.setup.updateWarehouse(warehouseId, body);
  }

  @RequirePermission('inventory.stock.read')
  @Get('items')
  async items(
    @Query(new ZodQuery(listStockItemsQuerySchema)) query: ListStockItemsQuery,
  ): Promise<{ data: StockItem[] }> {
    return { data: await this.setup.listItems(query) };
  }

  /** Import Data (ADR 0044 step 4): creates and updates many items; the result goes with the key. */
  @RequirePermission('inventory.items.create')
  @Idempotent({ completion: 'transaction' })
  @Post('items/import')
  @HttpCode(HttpStatus.OK)
  importItems(
    @Body(new ZodBody(importItemsRequestSchema)) body: ImportItemsRequest,
  ): Promise<DataImportResult> {
    return this.itemImport.importItems(body);
  }

  /** Import Data → opening stock: one receipt per warehouse (ADR 0044 step 4). */
  @RequirePermission('inventory.stock.receive')
  @Idempotent({ completion: 'transaction' })
  @Post('opening-stock/import')
  @HttpCode(HttpStatus.OK)
  importOpeningStock(
    @Body(new ZodBody(importOpeningStockRequestSchema)) body: ImportOpeningStockRequest,
  ): Promise<DataImportResult> {
    return this.stockService.importOpeningStock(body);
  }

  @RequirePermission('inventory.items.create')
  @Idempotent({ completion: 'transaction' })
  @Post('items')
  createItem(
    @Body(new ZodBody(createStockItemRequestSchema)) body: CreateStockItemRequest,
  ): Promise<StockItem> {
    return this.setup.createItem(body);
  }

  @RequirePermission('inventory.items.delete')
  @Idempotent()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('items/:id')
  deleteItem(@Param('id', id(() => inventoryErrors.itemNotFound())) itemId: string): Promise<void> {
    return this.setup.deleteItem(itemId);
  }

  @RequirePermission('inventory.items.purge')
  @Idempotent()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('items/:id/purge')
  purgeItem(@Param('id', id(() => inventoryErrors.itemNotFound())) itemId: string): Promise<void> {
    return this.setup.purgeItem(itemId);
  }

  @RequirePermission('inventory.items.edit')
  @Idempotent()
  @Patch('items/:id')
  updateItem(
    @Param('id', id(() => inventoryErrors.itemNotFound())) itemId: string,
    @Body(new ZodBody(updateStockItemRequestSchema)) body: UpdateStockItemRequest,
  ): Promise<StockItem> {
    return this.setup.updateItem(itemId, body);
  }

  @RequirePermission('inventory.stock.receive')
  @Idempotent({ completion: 'transaction' })
  @Post('receipts')
  async receive(
    @Body(new ZodBody(receiptRequestSchema)) body: ReceiptRequest,
  ): Promise<StockDocument> {
    return this.stockService.forViewer(await this.stockService.receive(body));
  }

  @RequirePermission('inventory.stock.adjust')
  @Idempotent({ completion: 'transaction' })
  @Post('adjustments')
  async adjust(
    @Body(new ZodBody(adjustmentRequestSchema)) body: AdjustmentRequest,
  ): Promise<StockDocument> {
    return this.stockService.forViewer(await this.stockService.adjust(body));
  }

  @RequirePermission('inventory.stock.transfer')
  @Idempotent({ completion: 'transaction' })
  @Post('transfers')
  async transfer(
    @Body(new ZodBody(transferRequestSchema)) body: TransferRequest,
  ): Promise<StockDocument> {
    return this.stockService.forViewer(await this.stockService.transfer(body));
  }

  @RequirePermission('inventory.stock.read')
  @Get('items/:id/movements')
  itemMovements(
    @Param('id', id(() => inventoryErrors.itemNotFound())) itemId: string,
    @Query(new ZodQuery(stockQuerySchema)) query: StockQuery,
  ): Promise<ItemMovements> {
    return this.stockService.itemMovements(itemId, query);
  }

  @RequirePermission('inventory.stock.read')
  @Get('stock')
  async stock(@Query(new ZodQuery(stockQuerySchema)) query: StockQuery) {
    return { data: await this.stockService.stock(query) };
  }

  @RequirePermission('inventory.stock.read')
  @Get('documents')
  async documents(
    @Query(new ZodQuery(listStockDocumentsQuerySchema)) query: ListStockDocumentsQuery,
  ) {
    return { data: await this.stockService.documents(query) };
  }

  @RequirePermission('inventory.stock.read')
  @Get('documents/:id')
  document(
    @Param('id', id(inventoryErrors.documentNotFound)) documentId: string,
  ): Promise<StockDocument> {
    return this.stockService.document(documentId);
  }

  @RequirePermission('inventory.stock.read')
  @Get('recipes/:productId')
  recipe(
    @Param('productId', id(inventoryErrors.productNotFound)) productId: string,
  ): Promise<Recipe> {
    return this.recipes.get(productId);
  }

  /** Replaces the recipe: configuration, not history, so a replay just writes the same lines. */
  @RequirePermission('inventory.recipes.edit')
  @Idempotent()
  @Put('recipes/:productId')
  putRecipe(
    @Param('productId', id(inventoryErrors.productNotFound)) productId: string,
    @Body(new ZodBody(putRecipeRequestSchema)) body: PutRecipeRequest,
  ): Promise<Recipe> {
    return this.recipes.put(productId, body);
  }

  @RequirePermission('inventory.costs.read')
  @Get('costs')
  async costs() {
    return { data: await this.recipes.costs() };
  }
}
