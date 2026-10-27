import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
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
  constructor(private readonly catalog: CatalogService) {}

  @RequirePermission('catalog.products.read')
  @Get('categories')
  async listCategories(
    @Query(new ZodQuery(listProductCategoriesQuerySchema)) query: ListProductCategoriesQuery,
  ): Promise<ProductCategoryListResponse> {
    return { data: await this.catalog.listCategories(query) };
  }

  @RequirePermission('catalog.products.manage')
  @Idempotent({ completion: 'transaction' })
  @Post('categories')
  createCategory(
    @Body(new ZodBody(createProductCategoryRequestSchema)) body: CreateProductCategoryRequest,
  ): Promise<ProductCategory> {
    return this.catalog.createCategory(body);
  }

  @RequirePermission('catalog.products.manage')
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

  @RequirePermission('catalog.products.manage')
  @Idempotent({ completion: 'transaction' })
  @Post('products')
  createProduct(
    @Body(new ZodBody(createProductRequestSchema)) body: CreateProductRequest,
  ): Promise<Product> {
    return this.catalog.createProduct(body);
  }

  @RequirePermission('catalog.products.manage')
  @Idempotent()
  @Patch('products/:id')
  updateProduct(
    @Param('id', uuidOr(catalogErrors.productNotFound)) id: string,
    @Body(new ZodBody(updateProductRequestSchema)) body: UpdateProductRequest,
  ): Promise<Product> {
    return this.catalog.updateProduct(id, body);
  }
}
