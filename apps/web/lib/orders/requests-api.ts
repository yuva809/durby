import {
  type ApproveStockRequest,
  type CreateStockRequest,
  type PackStockRequest,
  type ReceiveStockRequest,
  type RequestAvailability,
  requestAvailabilityResponseSchema,
  type RequestDriver,
  requestDriverListResponseSchema,
  type RequestWarehouse,
  requestWarehouseListResponseSchema,
  type StockRequest,
  stockRequestListResponseSchema,
  stockRequestSchema,
  type StockRequestStatus,
  type StockRequestSummary,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls of the branch stock request pages (docs/modules/orders.md → Branch requests, ADR 0045). */

const BASE = '/api/v1/stock-requests';

export const loadRequests = (
  store: Api,
  filter: { status?: readonly StockRequestStatus[]; mine?: boolean } = {},
): Promise<Result<StockRequestSummary[]>> => {
  const search = new URLSearchParams();
  if (filter.status) search.set('status', filter.status.join(','));
  if (filter.mine) search.set('mine', 'true');
  const query = search.toString();
  return read(store, `${BASE}${query ? `?${query}` : ''}`, list(stockRequestListResponseSchema));
};

export const loadRequest = (store: Api, id: string): Promise<Result<StockRequest>> =>
  read(store, `${BASE}/${id}`, stockRequestSchema);

export const loadRequestWarehouses = (store: Api): Promise<Result<RequestWarehouse[]>> =>
  read(store, `${BASE}/warehouses`, list(requestWarehouseListResponseSchema));

export const loadAvailability = (
  store: Api,
  warehouseId: string,
): Promise<Result<RequestAvailability[]>> =>
  read(store, `${BASE}/availability/${warehouseId}`, list(requestAvailabilityResponseSchema));

export const loadDrivers = (store: Api, warehouseId: string): Promise<Result<RequestDriver[]>> =>
  read(store, `${BASE}/drivers/${warehouseId}`, list(requestDriverListResponseSchema));

export const createRequest = (store: Api, action: ActionKey, body: CreateStockRequest) =>
  write(store, action, BASE, 'POST', body, stockRequestSchema);

const step =
  <B extends object>(path: string) =>
  (store: Api, action: ActionKey, id: string, body: B) =>
    write(store, action, `${BASE}/${id}/${path}`, 'POST', body, stockRequestSchema);

export const approveRequest = step<ApproveStockRequest>('approve');
export const rejectRequest = step<{ note?: string }>('reject');
export const cancelRequest = step<{ note?: string }>('cancel');
export const startPickingRequest = step<Record<string, never>>('start-picking');
export const packRequest = step<PackStockRequest>('pack');
export const assignDriver = step<{ driverUserId: string }>('driver');
export const pickUpRequest = step<Record<string, never>>('pick-up');
export const deliverRequest = step<{ note?: string }>('deliver');
export const receiveRequest = step<ReceiveStockRequest>('receive');
