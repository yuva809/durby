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
  type ClaimPrinterCommandRequest,
  claimPrinterCommandRequestSchema,
  type ClaimPrinterCommandResponse,
  type CompletePrinterCommandRequest,
  completePrinterCommandRequestSchema,
  type CreatePrinterCommandRequest,
  createPrinterCommandRequestSchema,
  type PrinterCommand,
  type PrinterCommandListResponse,
  type PrinterCommandQuery,
  printerCommandQuerySchema,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { posErrors } from './pos-errors';
import { PrinterCommandsService } from './printer-commands.service';

/**
 * Remote printer commands (ADR 0032 §15). Owner/Admin request and read them (`platform.settings.*`); the
 * location's till polls, claims and answers them (`pos.bills.print` at that location, checked in the service).
 */
@RequireFeature('pos')
@Controller('pos/printer-commands')
export class PrinterCommandsController {
  constructor(private readonly commands: PrinterCommandsService) {}

  @RequirePermission('platform.settings.manage')
  @Idempotent({ completion: 'transaction' })
  @Post()
  request(
    @Body(new ZodBody(createPrinterCommandRequestSchema)) body: CreatePrinterCommandRequest,
  ): Promise<PrinterCommand> {
    return this.commands.request(body);
  }

  @RequirePermission('platform.settings.read')
  @Get()
  async list(
    @Query(new ZodQuery(printerCommandQuerySchema)) query: PrinterCommandQuery,
  ): Promise<PrinterCommandListResponse> {
    return { data: await this.commands.list(query.locationId) };
  }

  @RequirePermission('pos.bills.print')
  @Get('pending')
  async pending(
    @Query(new ZodQuery(printerCommandQuerySchema)) query: PrinterCommandQuery,
  ): Promise<PrinterCommandListResponse> {
    return { data: await this.commands.pending(query.locationId) };
  }

  @RequirePermission('pos.bills.print')
  @Idempotent({ completion: 'transaction' })
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  claim(
    @Body(new ZodBody(claimPrinterCommandRequestSchema)) body: ClaimPrinterCommandRequest,
  ): Promise<ClaimPrinterCommandResponse> {
    return this.commands.claim(body.locationId);
  }

  @RequirePermission('pos.bills.print')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/result')
  @HttpCode(HttpStatus.OK)
  complete(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.printerCommandNotFound }))
    id: string,
    @Body(new ZodBody(completePrinterCommandRequestSchema)) body: CompletePrinterCommandRequest,
  ): Promise<PrinterCommand> {
    return this.commands.complete(id, body);
  }
}
