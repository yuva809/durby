import {
  type CreateDiningTableRequest,
  type DiningTable,
  diningTableListResponseSchema,
  diningTableSchema,
  type FloorTable,
  floorResponseSchema,
  type Order,
  orderSchema,
  type SendTicketRequest,
  type SendTicketResponse,
  sendTicketResponseSchema,
  type TableOrderResponse,
  tableOrderResponseSchema,
  type UpdateDiningTableRequest,
  type VoidLinesRequest,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls of the tables page (docs/modules/pos.md → Step 1), parsed with the shared schemas. */

export const loadTables = (
  store: Api,
  locationId: string,
  includeArchived = false,
): Promise<Result<DiningTable[]>> =>
  read(
    store,
    `/api/v1/pos/tables?locationId=${encodeURIComponent(locationId)}${includeArchived ? '&includeArchived=true' : ''}`,
    list(diningTableListResponseSchema),
  );

export const createTable = (
  store: Api,
  action: ActionKey,
  body: CreateDiningTableRequest,
): Promise<Result<DiningTable | null>> =>
  write(store, action, '/api/v1/pos/tables', 'POST', body, diningTableSchema);

export const updateTable = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateDiningTableRequest,
): Promise<Result<DiningTable | null>> =>
  write(store, action, `/api/v1/pos/tables/${id}`, 'PATCH', body, diningTableSchema);

/** Calls of the floor and order screens (docs/modules/pos.md → Step 3). */

export const loadFloor = (store: Api, locationId: string): Promise<Result<FloorTable[]>> =>
  read(
    store,
    `/api/v1/pos/floor?locationId=${encodeURIComponent(locationId)}`,
    list(floorResponseSchema),
  );

export const loadTableOrder = (store: Api, tableId: string): Promise<Result<TableOrderResponse>> =>
  read(store, `/api/v1/pos/tables/${tableId}/order`, tableOrderResponseSchema);

export const sendTicket = (
  store: Api,
  action: ActionKey,
  tableId: string,
  body: SendTicketRequest,
): Promise<Result<SendTicketResponse | null>> =>
  write(
    store,
    action,
    `/api/v1/pos/tables/${tableId}/tickets`,
    'POST',
    body,
    sendTicketResponseSchema,
  );

export const voidLines = (
  store: Api,
  action: ActionKey,
  orderId: string,
  body: VoidLinesRequest,
): Promise<Result<SendTicketResponse | null>> =>
  write(
    store,
    action,
    `/api/v1/pos/orders/${orderId}/voids`,
    'POST',
    body,
    sendTicketResponseSchema,
  );

export const closeOrder = (
  store: Api,
  action: ActionKey,
  orderId: string,
): Promise<Result<Order | null>> =>
  write(store, action, `/api/v1/pos/orders/${orderId}/close`, 'POST', undefined, orderSchema);
