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
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  categoryBulkRequestSchema,
  type CategoryBulkRequest,
  type CategoryBulkResponse,
  productBulkRequestSchema,
  type ProductBulkRequest,
  type ProductBulkResponse,
  type ImportProductsRequest,
  importProductsRequestSchema,
  type DataImportResult,
  type ImportCategoriesRequest,
  importCategoriesRequestSchema,
  type NumberProductsResponse,
  type OrderCategoriesRequest,
  orderCategoriesRequestSchema,
  type RenumberProductsResponse,
  type ImportProductsResponse,
  createProductCategoryRequestSchema,
  type CreateProductCategoryRequest,
  createProductRequestSchema,
  type CreateProductRequest,
  listProductCategoriesQuerySchema,
  type ListProductCategoriesQuery,
  listProductsQuerySchema,
  type ListProductsQuery,
  type Product,
  type ProductCategory,
  type ProductCategoryListResponse,
  type ProductListResponse,
  updateProductCategoryRequestSchema,
  type UpdateProductCategoryRequest,
  updateProductRequestSchema,
  type UpdateProductRequest,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { catalogErrors } from './catalog-errors';
import { CatalogBulkService } from './catalog-bulk.service';
import { CatalogService } from './catalog.service';
import { CategoryImportService } from './category-import.service';

/** A malformed id is a 404 of the entity, like an unknown one. */
const uuidOr = (notFound: () => Error) => new ParseUUIDPipe({ exceptionFactory: notFound });

/**
 * /api/v1/catalog (docs/modules/catalog.md → API). Creates append rows, so they complete their
 * idempotency key in the business transaction (rule 8); edits are naturally idempotent.
 */
@RequireFeature('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly bulk: CatalogBulkService,
    private readonly categoryImport: CategoryImportService,
  ) {}

  @RequirePermission('catalog.products.read')
  @Get('categories')
  async listCategories(
    @Query(new ZodQuery(listProductCategoriesQuerySchema)) query: ListProductCategoriesQuery,
  ): Promise<ProductCategoryListResponse> {
    return { data: await this.catalog.listCategories(query) };
  }

  @RequirePermission('catalog.products.create')
  @Idempotent({ completion: 'transaction' })
  @Post('categories')
  createCategory(
    @Body(new ZodBody(createProductCategoryRequestSchema)) body: CreateProductCategoryRequest,
  ): Promise<ProductCategory> {
    return this.catalog.createCategory(body);
  }

  @RequirePermission('catalog.products.edit')
  @Idempotent()
  @Patch('categories/:id')
  updateCategory(
    @Param('id', uuidOr(catalogErrors.categoryNotFound)) id: string,
    @Body(new ZodBody(updateProductCategoryRequestSchema)) body: UpdateProductCategoryRequest,
  ): Promise<ProductCategory> {
    return this.catalog.updateCategory(id, body);
  }

  /**
   * The tile image (ADR 0048). The url carries the category's imageVersion, so the browser may keep it: a new image
   * gets a new version and so a new url.
   */
  @RequirePermission('catalog.products.read')
  @Get('categories/:id/image')
  async categoryImage(
    @Param('id', uuidOr(catalogErrors.categoryNotFound)) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const image = await this.catalog.categoryImage(id);
    if (!image) throw catalogErrors.categoryNotFound();
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(image.data, { type: image.contentType, length: image.data.length });
  }

  /** The raw file as the body, `Content-Type` image/webp, image/png or image/jpeg (resized by the browser first). */
  @RequirePermission('catalog.products.edit')
  @Idempotent()
  @Put('categories/:id/image')
  setCategoryImage(
    @Param('id', uuidOr(catalogErrors.categoryNotFound)) id: string,
    @Req() req: Request,
  ): Promise<ProductCategory> {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) throw catalogErrors.categoryImageInvalid();
    return this.catalog.setCategoryImage(id, req.headers['content-type'] ?? '', body);
  }

  @RequirePermission('catalog.products.edit')
  @Idempotent()
  @Delete('categories/:id/image')
  removeCategoryImage(
    @Param('id', uuidOr(catalogErrors.categoryNotFound)) id: string,
  ): Promise<ProductCategory> {
    return this.catalog.removeCategoryImage(id);
  }

  /** The product's picture (ADR 0049), served like a category's tile image. */
  @RequirePermission('catalog.products.read')
  @Get('products/:id/image')
  async productImage(
    @Param('id', uuidOr(catalogErrors.productNotFound)) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const image = await this.catalog.productImage(id);
    if (!image) throw catalogErrors.productNotFound();
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(image.data, { type: image.contentType, length: image.data.length });
  }

  /** The raw file as the body, `Content-Type` image/webp, image/png or image/jpeg (resized by the browser first). */
  @RequirePermission('catalog.products.edit')
  @Idempotent()
  @Put('products/:id/image')
  setProductImage(
    @Param('id', uuidOr(catalogErrors.productNotFound)) id: string,
    @Req() req: Request,
  ): Promise<Product> {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) throw catalogErrors.productImageInvalid();
    return this.catalog.setProductImage(id, req.headers['content-type'] ?? '', body);
  }

  @RequirePermission('catalog.products.edit')
  @Idempotent()
  @Delete('products/:id/image')
  removeProductImage(
    @Param('id', uuidOr(catalogErrors.productNotFound)) id: string,
  ): Promise<Product> {
    return this.catalog.removeProductImage(id);
  }

  @RequirePermission('catalog.products.read')
  @Get('products')
  async listProducts(
    @Query(new ZodQuery(listProductsQuerySchema)) query: ListProductsQuery,
  ): Promise<ProductListResponse> {
    return { data: await this.catalog.listProducts(query) };
  }

  @RequirePermission('catalog.products.create')
  @Idempotent({ completion: 'transaction' })
  @Post('products')
  createProduct(
    @Body(new ZodBody(createProductRequestSchema)) body: CreateProductRequest,
  ): Promise<Product> {
    return this.catalog.createProduct(body);
  }

  /**
   * Many products at once (docs/modules/catalog.md → Bulk actions). Deletes append audit rows and
   * remove rows, so the result is stored with the key in the transaction (rule 8).
   */
  @RequirePermission('catalog.products.edit')
  @Idempotent({ completion: 'transaction' })
  @Post('products/bulk')
  @HttpCode(HttpStatus.OK)
  bulkProducts(
    @Body(new ZodBody(productBulkRequestSchema)) body: ProductBulkRequest,
  ): Promise<ProductBulkResponse> {
    return this.bulk.products(body);
  }

  /** Import Data → product categories (ADR 0044 step 4): adds the missing names. */
  @RequirePermission('catalog.products.create')
  @Idempotent({ completion: 'transaction' })
  @Post('categories/import')
  @HttpCode(HttpStatus.OK)
  importCategories(
    @Body(new ZodBody(importCategoriesRequestSchema)) body: ImportCategoriesRequest,
  ): Promise<DataImportResult> {
    return this.categoryImport.importCategories(body);
  }

  /** Drag-and-drop order (ADR 0043): sets positions, so a replay writes the same order again. */
  @RequirePermission('catalog.products.edit')
  @Idempotent()
  @Post('categories/order')
  @HttpCode(HttpStatus.OK)
  async orderCategories(
    @Body(new ZodBody(orderCategoriesRequestSchema)) body: OrderCategoriesRequest,
  ): Promise<ProductCategoryListResponse> {
    return { data: await this.catalog.orderCategories(body) };
  }

  @RequirePermission('catalog.products.edit')
  @Idempotent({ completion: 'transaction' })
  @Post('categories/bulk')
  @HttpCode(HttpStatus.OK)
  bulkCategories(
    @Body(new ZodBody(categoryBulkRequestSchema)) body: CategoryBulkRequest,
  ): Promise<CategoryBulkResponse> {
    return this.bulk.categories(body);
  }

  /** Appends products and categories: the result is stored with the key (rule 8). */
  @RequirePermission('catalog.products.create')
  @Idempotent({ completion: 'transaction' })
  @Post('products/import')
  @HttpCode(HttpStatus.OK)
  importProducts(
    @Body(new ZodBody(importProductsRequestSchema)) body: ImportProductsRequest,
  ): Promise<ImportProductsResponse> {
    return this.catalog.importProducts(body);
  }

  /** Fill missing numbers (ADR 0029): writes many products, so the result goes with the key. */
  @RequirePermission('catalog.products.create')
  @Idempotent({ completion: 'transaction' })
  @Post('products/number')
  @HttpCode(HttpStatus.OK)
  numberProducts(): Promise<NumberProductsResponse> {
    return this.catalog.numberProducts();
  }

  /** Renumber the menu 1…N (ADR 0043): changes existing numbers, so edit; many writes, so the result goes with the key. */
  @RequirePermission('catalog.products.edit')
  @Idempotent({ completion: 'transaction' })
  @Post('products/renumber')
  @HttpCode(HttpStatus.OK)
  renumberProducts(): Promise<RenumberProductsResponse> {
    return this.catalog.renumberProducts();
  }

  @RequirePermission('catalog.products.edit')
  @Idempotent()
  @Patch('products/:id')
  updateProduct(
    @Param('id', uuidOr(catalogErrors.productNotFound)) id: string,
    @Body(new ZodBody(updateProductRequestSchema)) body: UpdateProductRequest,
  ): Promise<Product> {
    return this.catalog.updateProduct(id, body);
  }
}
