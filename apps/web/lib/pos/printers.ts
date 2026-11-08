import {
  type CreatePrinterRequest,
  type Printer,
  printerListResponseSchema,
  printerSchema,
  type UpdatePrinterRequest,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Printers per location (ADR 0033), parsed with the shared schemas. */

export const loadPrinters = (store: Api, locationId: string): Promise<Result<Printer[]>> =>
  read(
    store,
    `/api/v1/pos/printers?locationId=${encodeURIComponent(locationId)}`,
    list(printerListResponseSchema),
  );

export const createPrinter = (
  store: Api,
  action: ActionKey,
  body: CreatePrinterRequest,
): Promise<Result<Printer | null>> =>
  write(store, action, '/api/v1/pos/printers', 'POST', body, printerSchema);

export const updatePrinter = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdatePrinterRequest,
): Promise<Result<Printer | null>> =>
  write(store, action, `/api/v1/pos/printers/${id}`, 'PATCH', body, printerSchema);

export const archivePrinter = (
  store: Api,
  action: ActionKey,
  id: string,
): Promise<Result<Printer | null>> =>
  write(store, action, `/api/v1/pos/printers/${id}/archive`, 'POST', {}, printerSchema);
