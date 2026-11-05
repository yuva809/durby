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
  Query,
} from '@nestjs/common';
import {
  type CreatePriceRuleRequest,
  createPriceRuleRequestSchema,
  type PriceRule,
  type PricesQuery,
  pricesQuerySchema,
  type PricesResponse,
  type UpdatePriceRuleRequest,
  updatePriceRuleRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { catalogErrors } from './catalog-errors';
import { PricingService } from './pricing.service';

const ruleId = new ParseUUIDPipe({ exceptionFactory: catalogErrors.priceRuleNotFound });

/** /api/v1/catalog/price-rules and /prices (docs/modules/catalog.md → Price rules, ADR 0030). */
@RequireFeature('catalog')
@Controller('catalog')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @RequirePermission('catalog.products.read')
  @Get('price-rules')
  async rules(): Promise<{ data: PriceRule[] }> {
    return { data: await this.pricing.listRules() };
  }

  /** Appends a rule: the result is stored with the key in the transaction (rule 8). */
  @RequirePermission('catalog.products.manage')
  @Idempotent({ completion: 'transaction' })
  @Post('price-rules')
  createRule(
    @Body(new ZodBody(createPriceRuleRequestSchema)) body: CreatePriceRuleRequest,
  ): Promise<PriceRule> {
    return this.pricing.createRule(body);
  }

  @RequirePermission('catalog.products.manage')
  @Idempotent()
  @Patch('price-rules/:id')
  updateRule(
    @Param('id', ruleId) id: string,
    @Body(new ZodBody(updatePriceRuleRequestSchema)) body: UpdatePriceRuleRequest,
  ): Promise<PriceRule> {
    return this.pricing.updateRule(id, body);
  }

  @RequirePermission('catalog.products.manage')
  @Idempotent()
  @Delete('price-rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRule(@Param('id', ruleId) id: string): Promise<void> {
    return this.pricing.deleteRule(id);
  }

  @RequirePermission('catalog.products.read')
  @Get('prices')
  prices(@Query(new ZodQuery(pricesQuerySchema)) query: PricesQuery): Promise<PricesResponse> {
    return this.pricing.prices(query);
  }
}
