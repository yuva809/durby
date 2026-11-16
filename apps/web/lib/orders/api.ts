import {
  type CancelSalesOrderRequest,
  type CreateOrderCustomerRequest,
  type CreateSalesOrderRequest,
  type DispatchSalesOrderRequest,
  type OrderCustomer,
  type PickSalesOrderRequest,
  orderCustomerListResponseSchema,
  orderCustomerSchema,
  type SalesOrder,
  type SalesOrderListResponse,
  type SalesOrderNoteRequest,
  salesOrderListResponseSchema,
  salesOrderSchema,
  type SalesOrderStatus,
  type UpdateOrderCustomerRequest,
  type UpdateSalesOrderRequest,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls of the orders pages (docs/modules/orders.md → Web, ADR 0044), parsed with the shared schemas. */

const BASE = '/api/v1/orders';

export const loadCustomers = (
  store: Api,
  includeArchived = false,
): Promise<Result<OrderCustomer[]>> =>
  read(
    store,
    `${BASE}/customers${includeArchived ? '?includeArchived=true' : ''}`,
    list(orderCustomerListResponseSchema),
  );

export const createCustomer = (store: Api, action: ActionKey, body: CreateOrderCustomerRequest) =>
  write(store, action, `${BASE}/customers`, 'POST', body, orderCustomerSchema);

export const updateCustomer = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateOrderCustomerRequest,
) => write(store, action, `${BASE}/customers/${id}`, 'PATCH', body, orderCustomerSchema);

export interface OrderFilter {
  status?: SalesOrderStatus | readonly SalesOrderStatus[];
  locationId?: string;
  /** ISO instants. */
  from?: string;
  to?: string;
}

/** The list query: filters, page size and the next page's cursor. */
export function ordersQuery(filter: OrderFilter, cursor?: string, limit = 50): string {
  const search = new URLSearchParams();
  for (const status of typeof filter.status === 'string' ? [filter.status] : (filter.status ?? []))
    search.append('status', status);
  if (filter.locationId) search.set('locationId', filter.locationId);
  if (filter.from) search.set('from', filter.from);
  if (filter.to) search.set('to', filter.to);
  search.set('limit', String(limit));
  if (cursor) search.set('cursor', cursor);
  return `?${search.toString()}`;
}

export const loadOrders = (
  store: Api,
  filter: OrderFilter,
  cursor?: string,
  limit?: number,
): Promise<Result<SalesOrderListResponse>> =>
  read(store, `${BASE}${ordersQuery(filter, cursor, limit)}`, salesOrderListResponseSchema);

export const loadOrder = (store: Api, id: string): Promise<Result<SalesOrder>> =>
  read(store, `${BASE}/${id}`, salesOrderSchema);

export const createOrder = (store: Api, action: ActionKey, body: CreateSalesOrderRequest) =>
  write(store, action, BASE, 'POST', body, salesOrderSchema);

export const updateOrder = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateSalesOrderRequest,
) => write(store, action, `${BASE}/${id}`, 'PATCH', body, salesOrderSchema);

export const confirmOrder = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `${BASE}/${id}/confirm`, 'POST', {}, salesOrderSchema);

export const cancelOrder = (
  store: Api,
  action: ActionKey,
  id: string,
  body: CancelSalesOrderRequest,
) => write(store, action, `${BASE}/${id}/cancel`, 'POST', body, salesOrderSchema);

/** Picking and delivery (step 3). */
export const startPicking = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `${BASE}/${id}/start-picking`, 'POST', {}, salesOrderSchema);

export const pickOrder = (store: Api, action: ActionKey, id: string, body: PickSalesOrderRequest) =>
  write(store, action, `${BASE}/${id}/pick`, 'POST', body, salesOrderSchema);

export const dispatchOrder = (
  store: Api,
  action: ActionKey,
  id: string,
  body: DispatchSalesOrderRequest,
) => write(store, action, `${BASE}/${id}/dispatch`, 'POST', body, salesOrderSchema);

export const deliverOrder = (
  store: Api,
  action: ActionKey,
  id: string,
  body: SalesOrderNoteRequest,
) => write(store, action, `${BASE}/${id}/deliver`, 'POST', body, salesOrderSchema);

export const returnOrder = (
  store: Api,
  action: ActionKey,
  id: string,
  body: SalesOrderNoteRequest,
) => write(store, action, `${BASE}/${id}/return`, 'POST', body, salesOrderSchema);
