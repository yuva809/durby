import {
  type Bill,
  billSchema,
  type CancelBillRequest,
  type CheckListResponse,
  checkListResponseSchema,
  type CreateBillRequest,
  type GuestCheck,
  guestCheckSchema,
  type ListChecksQuery,
} from '@durby/shared';
import { type Api, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Bills and guest checks (docs/modules/pos.md → Step 4), parsed with the shared schemas. */

export const createBill = (
  store: Api,
  action: ActionKey,
  body: CreateBillRequest,
): Promise<Result<Bill | null>> =>
  write(store, action, '/api/v1/pos/bills', 'POST', body, billSchema);

export const cancelBill = (
  store: Api,
  action: ActionKey,
  billId: string,
  body: CancelBillRequest,
): Promise<Result<Bill | null>> =>
  write(store, action, `/api/v1/pos/bills/${billId}/cancel`, 'POST', body, billSchema);

export const loadCheck = (store: Api, checkId: string): Promise<Result<GuestCheck>> =>
  read(store, `/api/v1/pos/checks/${checkId}`, guestCheckSchema);

export function loadChecks(
  store: Api,
  query: Partial<ListChecksQuery>,
): Promise<Result<CheckListResponse>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return read(store, `/api/v1/pos/checks${search ? `?${search}` : ''}`, checkListResponseSchema);
}
