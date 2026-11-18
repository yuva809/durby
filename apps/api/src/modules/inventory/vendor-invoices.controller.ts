import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  type ListVendorInvoicesQuery,
  listVendorInvoicesQuerySchema,
  type RejectVendorInvoiceRequest,
  rejectVendorInvoiceRequestSchema,
  type SubmitVendorInvoiceRequest,
  submitVendorInvoiceRequestSchema,
  type UpdateVendorInvoiceRequest,
  updateVendorInvoiceRequestSchema,
  type VendorInvoice,
  type VendorInvoiceSummary,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody, ZodQuery } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { vendorInvoiceErrors, VendorInvoicesService } from './vendor-invoices.service';

const invoiceId = new ParseUUIDPipe({ exceptionFactory: () => vendorInvoiceErrors.notFound() });

/**
 * /api/v1/inventory/invoices (docs/modules/inventory.md → Vendor invoices, ADR 0054). Each route names the key it
 * needs somewhere; the service checks it at the invoice's warehouse. Submitting and deciding append rows, so their
 * idempotency key completes in the business transaction (rule 8); an edit replaces the pending invoice (set-state).
 */
@RequireFeature('inventory')
@Controller('inventory/invoices')
export class VendorInvoicesController {
  constructor(private readonly invoices: VendorInvoicesService) {}

  /** Those where the caller receives goods or approves invoices; newest first. */
  @RequirePermission('inventory.stock.read')
  @Get()
  async list(
    @Query(new ZodQuery(listVendorInvoicesQuerySchema)) query: ListVendorInvoicesQuery,
  ): Promise<{ data: VendorInvoiceSummary[] }> {
    return { data: await this.invoices.list(query) };
  }

  @RequirePermission('inventory.stock.read')
  @Get(':id')
  get(@Param('id', invoiceId) id: string): Promise<VendorInvoice> {
    return this.invoices.get(id);
  }

  @RequirePermission('inventory.stock.receive')
  @Idempotent({ completion: 'transaction' })
  @Post()
  submit(
    @Body(new ZodBody(submitVendorInvoiceRequestSchema)) body: SubmitVendorInvoiceRequest,
  ): Promise<VendorInvoice> {
    return this.invoices.submit(body);
  }

  @RequirePermission('inventory.stock.read')
  @Idempotent()
  @Put(':id')
  update(
    @Param('id', invoiceId) id: string,
    @Body(new ZodBody(updateVendorInvoiceRequestSchema)) body: UpdateVendorInvoiceRequest,
  ): Promise<VendorInvoice> {
    return this.invoices.update(id, body);
  }

  @RequirePermission('inventory.invoices.approve')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/approve')
  approve(@Param('id', invoiceId) id: string): Promise<VendorInvoice> {
    return this.invoices.approve(id);
  }

  @RequirePermission('inventory.invoices.approve')
  @Idempotent({ completion: 'transaction' })
  @Post(':id/reject')
  reject(
    @Param('id', invoiceId) id: string,
    @Body(new ZodBody(rejectVendorInvoiceRequestSchema)) body: RejectVendorInvoiceRequest,
  ): Promise<VendorInvoice> {
    return this.invoices.reject(id, body);
  }
}
