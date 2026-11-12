import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  type Bill,
  type CancelBillRequest,
  cancelBillRequestSchema,
  type CheckListResponse,
  type CreateBillRequest,
  createBillRequestSchema,
  type GuestCheck,
  type ListChecksQuery,
  listChecksQuerySchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { BillsService } from './bills.service';
import { posErrors } from './pos-errors';

/**
 * Bills and guest checks (docs/modules/pos.md → Step 4, ADR 0036). The guard checks each key for some location;
 * the service checks it at the bill's location. Billing and cancelling append rows, so they complete their
 * idempotency key in the business transaction (rule 8).
 */
@RequireFeature('pos')
@Controller('pos')
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @RequirePermission('pos.bills.print')
  @Idempotent({ completion: 'transaction' })
  @Post('bills')
  create(@Body(new ZodBody(createBillRequestSchema)) body: CreateBillRequest): Promise<Bill> {
    return this.bills.create(body);
  }

  @RequirePermission('pos.bills.print')
  @Get('bills/:id')
  get(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.billNotFound })) id: string,
  ): Promise<Bill> {
    return this.bills.get(id);
  }

  @RequirePermission('pos.bills.cancel')
  @Idempotent({ completion: 'transaction' })
  @Post('bills/:id/cancel')
  cancel(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.billNotFound })) id: string,
    @Body(new ZodBody(cancelBillRequestSchema)) body: CancelBillRequest,
  ): Promise<Bill> {
    return this.bills.cancel(id, body);
  }

  @RequirePermission('pos.bills.print')
  @Get('checks')
  checks(
    @Query(new ZodQuery(listChecksQuerySchema)) query: ListChecksQuery,
  ): Promise<CheckListResponse> {
    return this.bills.listChecks(query);
  }

  @RequirePermission('pos.bills.print')
  @Get('checks/:id')
  check(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.checkNotFound })) id: string,
  ): Promise<GuestCheck> {
    return this.bills.getCheck(id);
  }
}
