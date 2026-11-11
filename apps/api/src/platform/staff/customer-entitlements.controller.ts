import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  type CustomerEntitlements,
  type FeatureCatalogResponse,
  type ResetFeatureRequest,
  resetFeatureRequestSchema,
  type SetFeatureRequest,
  setFeatureRequestSchema,
  type SetPlanRequest,
  setPlanRequestSchema,
} from '@durby/shared';
import { ZodBody } from '../http';
import { IdempotencyExempt, PlatformOnly } from '../markers';
import { CustomerEntitlementsService } from './customer-entitlements.service';
import { StaffContext } from './staff-context';
import { staffErrors } from './staff-errors';

const idPipe = new ParseUUIDPipe({ exceptionFactory: staffErrors.customerNotFound });
const SET_STATE =
  'staff set-state write: the same body again changes nothing and writes no audit row (ADR 0017 §8)';

/** /api/v1/platform/feature-catalog: the registry as the portal renders it (admin portal 1d). */
@Controller('platform/feature-catalog')
export class FeatureCatalogController {
  constructor(private readonly entitlements: CustomerEntitlementsService) {}

  @PlatformOnly('staff.entitlements.read')
  @Get()
  catalog(): Promise<FeatureCatalogResponse> {
    return this.entitlements.catalog();
  }
}

/**
 * /api/v1/platform/customers/:id/{entitlements,plan,features} (docs/platform/admin-portal.md →
 * Modules). Writes need a fresh session and a reason; each is audited in the customer's log and the
 * platform log, in one transaction.
 */
@Controller('platform/customers/:id')
export class CustomerEntitlementsController {
  constructor(
    private readonly entitlements: CustomerEntitlementsService,
    private readonly context: StaffContext,
  ) {}

  @PlatformOnly('staff.entitlements.read')
  @Get('entitlements')
  show(@Param('id', idPipe) id: string): Promise<CustomerEntitlements> {
    return this.entitlements.show(id);
  }

  /** Changes the plan only; the customer's overrides stay in place. */
  @PlatformOnly('staff.entitlements.manage', { fresh: true })
  @IdempotencyExempt(SET_STATE)
  @Put('plan')
  setPlan(
    @Param('id', idPipe) id: string,
    @Body(new ZodBody(setPlanRequestSchema)) body: SetPlanRequest,
  ): Promise<CustomerEntitlements> {
    return this.entitlements.setPlan(this.staffId(), id, body);
  }

  @PlatformOnly('staff.entitlements.manage', { fresh: true })
  @IdempotencyExempt(SET_STATE)
  @Put('features/:key')
  setFeature(
    @Param('id', idPipe) id: string,
    @Param('key') key: string,
    @Body(new ZodBody(setFeatureRequestSchema)) body: SetFeatureRequest,
  ): Promise<CustomerEntitlements> {
    return this.entitlements.setFeature(this.staffId(), id, key, body);
  }

  /** Back to the plan default. POST, not DELETE: the reason travels in the body. */
  @PlatformOnly('staff.entitlements.manage', { fresh: true })
  @IdempotencyExempt(SET_STATE)
  @Post('features/:key/reset')
  @HttpCode(HttpStatus.OK)
  resetFeature(
    @Param('id', idPipe) id: string,
    @Param('key') key: string,
    @Body(new ZodBody(resetFeatureRequestSchema)) body: ResetFeatureRequest,
  ): Promise<CustomerEntitlements> {
    return this.entitlements.resetFeature(this.staffId(), id, key, body);
  }

  private staffId(): string {
    return this.context.require().staffId;
  }
}
