import {
  type PrepStation,
  type SettableTicketStatus,
  stationBoardResponseSchema,
  type StationTicket,
  stationTicketSchema,
  type BillLayout,
  billLayoutSchema,
  type CreateDiningAreaRequest,
  type CreateDiningTableRequest,
  type DiningArea,
  diningAreaListResponseSchema,
  diningAreaSchema,
  type DiningTable,
  diningTableListResponseSchema,
  diningTableSchema,
  type FloorTable,
  floorResponseSchema,
  type Order,
  orderSchema,
  type SendTicketRequest,
  type UpdateOrderRequest,
  type SendTicketResponse,
  sendTicketResponseSchema,
  type TableOrderResponse,
  tableOrderResponseSchema,
  type UpdateDiningAreaRequest,
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

/** A new QR menu code for the table; its old QR stops working (docs/modules/pos.md → QR menu). */
export const renewMenuCode = (
  store: Api,
  action: ActionKey,
  id: string,
): Promise<Result<DiningTable | null>> =>
  write(store, action, `/api/v1/pos/tables/${id}/menu-token`, 'POST', {}, diningTableSchema);

/** The kitchen and bar screens (docs/modules/pos.md → Kitchen and bar screens). */
export const loadStationBoard = (
  store: Api,
  station: PrepStation,
  locationId: string,
): Promise<Result<StationTicket[]>> =>
  read(
    store,
    `/api/v1/pos/stations/${station}/tickets?locationId=${encodeURIComponent(locationId)}`,
    list(stationBoardResponseSchema),
  );

export const moveTicket = (
  store: Api,
  action: ActionKey,
  station: PrepStation,
  ticketId: string,
  status: SettableTicketStatus,
): Promise<Result<StationTicket | null>> =>
  write(
    store,
    action,
    `/api/v1/pos/stations/${station}/tickets/${ticketId}/status`,
    'POST',
    { status },
    stationTicketSchema,
  );

/** A waiter serves a ready ticket from the till. */
export const serveTicket = (
  store: Api,
  action: ActionKey,
  orderId: string,
  ticketId: string,
): Promise<Result<Order | null>> =>
  write(
    store,
    action,
    `/api/v1/pos/orders/${orderId}/tickets/${ticketId}/served`,
    'POST',
    {},
    orderSchema,
  );

/** Calls of the floor and order screens (docs/modules/pos.md → Step 3). */

export const loadFloor = (store: Api, locationId: string): Promise<Result<FloorTable[]>> =>
  read(
    store,
    `/api/v1/pos/floor?locationId=${encodeURIComponent(locationId)}`,
    list(floorResponseSchema),
  );

export const loadTableOrder = (store: Api, tableId: string): Promise<Result<TableOrderResponse>> =>
  read(store, `/api/v1/pos/tables/${tableId}/order`, tableOrderResponseSchema);

/** The bill's header and footer at a location (docs/modules/pos.md → Bill layout). */
export const loadBillLayout = (store: Api, locationId: string): Promise<Result<BillLayout>> =>
  read(
    store,
    `/api/v1/pos/bill-layout?locationId=${encodeURIComponent(locationId)}`,
    billLayoutSchema,
  );

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

/** Guests at the table of an open order (docs/modules/pos.md → Covers). */
export const updateOrder = (
  store: Api,
  action: ActionKey,
  orderId: string,
  body: UpdateOrderRequest,
): Promise<Result<Order | null>> =>
  write(store, action, `/api/v1/pos/orders/${orderId}`, 'PATCH', body, orderSchema);

export const closeOrder = (
  store: Api,
  action: ActionKey,
  orderId: string,
): Promise<Result<Order | null>> =>
  write(store, action, `/api/v1/pos/orders/${orderId}/close`, 'POST', undefined, orderSchema);

/** Moves an open order to a free table at its location (ADR 0069). */
export const moveOrder = (
  store: Api,
  action: ActionKey,
  orderId: string,
  tableId: string,
): Promise<Result<Order | null>> =>
  write(store, action, `/api/v1/pos/orders/${orderId}/move`, 'POST', { tableId }, orderSchema);

/** Calls of the tables page's areas (docs/modules/pos.md → Areas). */

export const loadAreas = (store: Api, locationId: string): Promise<Result<DiningArea[]>> =>
  read(
    store,
    `/api/v1/pos/areas?locationId=${encodeURIComponent(locationId)}`,
    list(diningAreaListResponseSchema),
  );

export const createArea = (
  store: Api,
  action: ActionKey,
  body: CreateDiningAreaRequest,
): Promise<Result<DiningArea | null>> =>
  write(store, action, '/api/v1/pos/areas', 'POST', body, diningAreaSchema);

export const updateArea = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateDiningAreaRequest,
): Promise<Result<DiningArea | null>> =>
  write(store, action, `/api/v1/pos/areas/${id}`, 'PATCH', body, diningAreaSchema);

export const deleteArea = (store: Api, action: ActionKey, id: string): Promise<Result<null>> =>
  write(store, action, `/api/v1/pos/areas/${id}`, 'DELETE');
