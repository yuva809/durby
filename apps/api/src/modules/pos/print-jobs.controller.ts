import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  type ClaimPrintJobRequest,
  claimPrintJobRequestSchema,
  type ClaimPrintJobResponse,
  type DuePrintJobsResponse,
  type PrintJob,
  type PrintJobQuery,
  printJobQuerySchema,
  type PrintJobResultRequest,
  printJobResultRequestSchema,
  type PrintJobStatusResponse,
  type QueueBillPrintJobRequest,
  queueBillPrintJobRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { posErrors } from './pos-errors';
import { PrintJobsService } from './print-jobs.service';

/**
 * Print jobs (ADR 0033 §10–12). Tills with the app poll, claim and answer them (`pos.bills.print` at the
 * location, checked in the service); a device without the app queues a bill; the warnings read the status
 * (`pos.orders.read`).
 */
@RequireFeature('pos')
@Controller('pos/print-jobs')
export class PrintJobsController {
  constructor(private readonly jobs: PrintJobsService) {}

  @RequirePermission('pos.bills.print')
  @Get('due')
  due(
    @Query(new ZodQuery(printJobQuerySchema)) query: PrintJobQuery,
  ): Promise<DuePrintJobsResponse> {
    return this.jobs.due(query.locationId);
  }

  @RequirePermission('pos.bills.print')
  @Idempotent({ completion: 'transaction' })
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  claim(
    @Body(new ZodBody(claimPrintJobRequestSchema)) body: ClaimPrintJobRequest,
  ): Promise<ClaimPrintJobResponse> {
    return this.jobs.claim(body.locationId);
  }

  @RequirePermission('pos.bills.print')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/result')
  @HttpCode(HttpStatus.OK)
  answer(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => posErrors.printJobNotFound() }))
    id: string,
    @Body(new ZodBody(printJobResultRequestSchema)) body: PrintJobResultRequest,
  ): Promise<PrintJob> {
    return this.jobs.answer(id, body);
  }

  @RequirePermission('pos.bills.print')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/reprint')
  @HttpCode(HttpStatus.OK)
  reprint(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => posErrors.printJobNotFound() }))
    id: string,
  ): Promise<PrintJob> {
    return this.jobs.reprint(id);
  }

  @RequirePermission('pos.bills.print')
  @Idempotent({ completion: 'transaction' })
  @Post('bill')
  queueBill(
    @Body(new ZodBody(queueBillPrintJobRequestSchema)) body: QueueBillPrintJobRequest,
  ): Promise<PrintJob> {
    return this.jobs.queueBill(body);
  }

  @RequirePermission('pos.orders.read')
  @Get('status')
  status(
    @Query(new ZodQuery(printJobQuerySchema)) query: PrintJobQuery,
  ): Promise<PrintJobStatusResponse> {
    return this.jobs.status(query.locationId);
  }
}

/**
 * The print warnings of a station's screen and its reprints (ADR 0033 §12): only that station's tickets, with the
 * screen's own permission, since kitchen and bar staff don't read orders.
 */
@RequireFeature('pos')
@Controller('pos/stations')
export class StationPrintJobsController {
  constructor(private readonly jobs: PrintJobsService) {}

  @RequirePermission('pos.kitchen.use')
  @Get('kitchen/print-status')
  kitchenStatus(
    @Query(new ZodQuery(printJobQuerySchema)) query: PrintJobQuery,
  ): Promise<PrintJobStatusResponse> {
    return this.jobs.status(query.locationId, 'kitchen');
  }

  @RequirePermission('pos.bar.use')
  @Get('bar/print-status')
  barStatus(
    @Query(new ZodQuery(printJobQuerySchema)) query: PrintJobQuery,
  ): Promise<PrintJobStatusResponse> {
    return this.jobs.status(query.locationId, 'bar');
  }

  @RequirePermission('pos.kitchen.use')
  @Idempotent({ completion: 'transaction' })
  @Post('kitchen/print-jobs/:id/reprint')
  @HttpCode(HttpStatus.OK)
  reprintKitchen(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => posErrors.printJobNotFound() }))
    id: string,
  ): Promise<PrintJob> {
    return this.jobs.reprint(id, 'kitchen');
  }

  @RequirePermission('pos.bar.use')
  @Idempotent({ completion: 'transaction' })
  @Post('bar/print-jobs/:id/reprint')
  @HttpCode(HttpStatus.OK)
  reprintBar(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => posErrors.printJobNotFound() }))
    id: string,
  ): Promise<PrintJob> {
    return this.jobs.reprint(id, 'bar');
  }
}
