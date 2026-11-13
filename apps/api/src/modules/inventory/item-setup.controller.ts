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
  type Bom,
  type CreateUnitOfMeasureRequest,
  createUnitOfMeasureRequestSchema,
  type CreateVariantAttributeRequest,
  createVariantAttributeRequestSchema,
  type GenerateVariantsRequest,
  generateVariantsRequestSchema,
  type GenerateVariantsResponse,
  type ListUnitsQuery,
  listUnitsQuerySchema,
  type ListVariantAttributesQuery,
  listVariantAttributesQuerySchema,
  type ProductionRequest,
  productionRequestSchema,
  type PutBomRequest,
  putBomRequestSchema,
  type StockDocument,
  type UnitOfMeasure,
  type UpdateUnitOfMeasureRequest,
  updateUnitOfMeasureRequestSchema,
  type UpdateVariantAttributeRequest,
  updateVariantAttributeRequestSchema,
  type VariantAttribute,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { BomsService } from './boms.service';
import { inventoryErrors } from './inventory-errors';
import { StockService } from './stock.service';
import { UnitsService } from './units.service';
import { VariantsService } from './variants.service';

const id = (notFound: () => Error) => new ParseUUIDPipe({ exceptionFactory: notFound });

/**
 * /api/v1/inventory: units of measurement, variant attributes and variants, bills of materials and production orders
 * (docs/modules/inventory.md → Step 5, ADR 0038). Units, attributes and variants are item setup (`inventory.items.*`),
 * bills of materials are recipes for stock items (`inventory.recipes.*`), production is a stock document at the
 * warehouse's location (`inventory.stock.produce`). Creates append rows, so they complete their idempotency key in the
 * business transaction (rule 8).
 */
@RequireFeature('inventory')
@Controller('inventory')
export class ItemSetupController {
  constructor(
    private readonly units: UnitsService,
    private readonly variants: VariantsService,
    private readonly boms: BomsService,
    private readonly stockService: StockService,
  ) {}

  @RequirePermission('inventory.stock.read')
  @Get('units')
  async listUnits(
    @Query(new ZodQuery(listUnitsQuerySchema)) query: ListUnitsQuery,
  ): Promise<{ data: UnitOfMeasure[] }> {
    return { data: await this.units.list(query) };
  }

  @RequirePermission('inventory.items.create')
  @Idempotent({ completion: 'transaction' })
  @Post('units')
  createUnit(
    @Body(new ZodBody(createUnitOfMeasureRequestSchema)) body: CreateUnitOfMeasureRequest,
  ): Promise<UnitOfMeasure> {
    return this.units.create(body);
  }

  @RequirePermission('inventory.items.edit')
  @Idempotent()
  @Patch('units/:id')
  updateUnit(
    @Param('id', id(() => inventoryErrors.unitNotFound())) unitId: string,
    @Body(new ZodBody(updateUnitOfMeasureRequestSchema)) body: UpdateUnitOfMeasureRequest,
  ): Promise<UnitOfMeasure> {
    return this.units.update(unitId, body);
  }

  @RequirePermission('inventory.stock.read')
  @Get('attributes')
  async listAttributes(
    @Query(new ZodQuery(listVariantAttributesQuerySchema)) query: ListVariantAttributesQuery,
  ): Promise<{ data: VariantAttribute[] }> {
    return { data: await this.variants.listAttributes(query) };
  }

  @RequirePermission('inventory.items.create')
  @Idempotent({ completion: 'transaction' })
  @Post('attributes')
  createAttribute(
    @Body(new ZodBody(createVariantAttributeRequestSchema)) body: CreateVariantAttributeRequest,
  ): Promise<VariantAttribute> {
    return this.variants.createAttribute(body);
  }

  @RequirePermission('inventory.items.edit')
  @Idempotent()
  @Patch('attributes/:id')
  updateAttribute(
    @Param('id', id(() => inventoryErrors.attributeNotFound())) attributeId: string,
    @Body(new ZodBody(updateVariantAttributeRequestSchema)) body: UpdateVariantAttributeRequest,
  ): Promise<VariantAttribute> {
    return this.variants.updateAttribute(attributeId, body);
  }

  /** Creates the missing combinations as stock items: appends rows, so it completes in the transaction. */
  @RequirePermission('inventory.items.create')
  @Idempotent({ completion: 'transaction' })
  @Post('items/:id/variants')
  generateVariants(
    @Param('id', id(() => inventoryErrors.itemNotFound())) itemId: string,
    @Body(new ZodBody(generateVariantsRequestSchema)) body: GenerateVariantsRequest,
  ): Promise<GenerateVariantsResponse> {
    return this.variants.generate(itemId, body);
  }

  @RequirePermission('inventory.stock.read')
  @Get('boms')
  async listBoms(): Promise<{ data: Bom[] }> {
    return { data: await this.boms.list() };
  }

  @RequirePermission('inventory.stock.read')
  @Get('boms/:itemId')
  bom(@Param('itemId', id(inventoryErrors.bomNotFound)) itemId: string): Promise<Bom> {
    return this.boms.get(itemId);
  }

  /** Replaces the bill: configuration, not history, so a replay just writes the same lines. */
  @RequirePermission('inventory.recipes.edit')
  @Idempotent()
  @Put('boms/:itemId')
  putBom(
    @Param('itemId', id(() => inventoryErrors.itemNotFound())) itemId: string,
    @Body(new ZodBody(putBomRequestSchema)) body: PutBomRequest,
  ): Promise<Bom> {
    return this.boms.put(itemId, body);
  }

  @RequirePermission('inventory.recipes.delete')
  @Idempotent()
  @Delete('boms/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteBom(@Param('itemId', id(inventoryErrors.bomNotFound)) itemId: string): Promise<void> {
    return this.boms.remove(itemId);
  }

  @RequirePermission('inventory.stock.produce')
  @Idempotent({ completion: 'transaction' })
  @Post('productions')
  produce(
    @Body(new ZodBody(productionRequestSchema)) body: ProductionRequest,
  ): Promise<StockDocument> {
    return this.stockService.produce(body);
  }
}
