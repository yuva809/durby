import {
  type RejectVendorInvoiceRequest,
  type SubmitVendorInvoiceRequest,
  type VendorInvoice,
  vendorInvoiceListResponseSchema,
  vendorInvoiceSchema,
  type VendorInvoiceStatus,
  type VendorInvoiceSummary,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** The vendor invoice approval queue (docs/modules/inventory.md → Vendor invoices, ADR 0051). */

const BASE = '/api/v1/inventory/invoices';

export const loadInvoices = (
  store: Api,
  status?: VendorInvoiceStatus,
): Promise<Result<VendorInvoiceSummary[]>> =>
  read(store, `${BASE}${status ? `?status=${status}` : ''}`, list(vendorInvoiceListResponseSchema));

export const loadInvoice = (store: Api, id: string): Promise<Result<VendorInvoice>> =>
  read(store, `${BASE}/${id}`, vendorInvoiceSchema);

export const submitInvoice = (store: Api, action: ActionKey, body: SubmitVendorInvoiceRequest) =>
  write(store, action, BASE, 'POST', body, vendorInvoiceSchema);

export const updateInvoice = (
  store: Api,
  action: ActionKey,
  id: string,
  body: SubmitVendorInvoiceRequest,
) => write(store, action, `${BASE}/${id}`, 'PUT', body, vendorInvoiceSchema);

export const approveInvoice = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `${BASE}/${id}/approve`, 'POST', undefined, vendorInvoiceSchema);

export const rejectInvoice = (
  store: Api,
  action: ActionKey,
  id: string,
  body: RejectVendorInvoiceRequest,
) => write(store, action, `${BASE}/${id}/reject`, 'POST', body, vendorInvoiceSchema);
