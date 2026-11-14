import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  categoryBulkRequestSchema,
  type CategoryBulkRequest,
  type CategoryBulkResponse,
  productBulkRequestSchema,
  type ProductBulkRequest,
  type ProductBulkResponse,
  type ImportProductsRequest,
  importProductsRequestSchema,
  type NumberProductsResponse,
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
