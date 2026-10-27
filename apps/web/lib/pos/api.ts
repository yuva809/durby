import {
  type CreateDiningTableRequest,
  type DiningTable,
  diningTableListResponseSchema,
  diningTableSchema,
  type UpdateDiningTableRequest,
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
