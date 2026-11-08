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
  type CreatePrinterRequest,
  createPrinterRequestSchema,
  type Printer,
  type PrinterListResponse,
  type PrinterQuery,
  printerQuerySchema,
  type UpdatePrinterRequest,
  updatePrinterRequestSchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { posErrors } from './pos-errors';
import { PrintersService } from './printers.service';

/**
 * Printers per location (ADR 0033): Settings → Printers reads them (`platform.settings.read`) and Owner/Admin
 * change them (`platform.settings.manage`). Tills get them with the bill layout.
 */
@RequireFeature('pos')
@Controller('pos/printers')
export class PrintersController {
  constructor(private readonly printers: PrintersService) {}

  @RequirePermission('platform.settings.read')
  @Get()
  async list(
    @Query(new ZodQuery(printerQuerySchema)) query: PrinterQuery,
  ): Promise<PrinterListResponse> {
    return { data: await this.printers.list(query.locationId) };
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent({ completion: 'transaction' })
  @Post()
  create(
    @Body(new ZodBody(createPrinterRequestSchema)) body: CreatePrinterRequest,
  ): Promise<Printer> {
    return this.printers.create(body);
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent({ completion: 'transaction' })
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => posErrors.printerNotFound() }))
    id: string,
    @Body(new ZodBody(updatePrinterRequestSchema)) body: UpdatePrinterRequest,
  ): Promise<Printer> {
    return this.printers.update(id, body);
  }

  @RequirePermission('platform.settings.manage')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => posErrors.printerNotFound() }))
    id: string,
  ): Promise<Printer> {
    return this.printers.archive(id);
  }
}
