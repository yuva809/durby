import {
  type CreateCombinationRequest,
  type PutTableRuleRequest,
  type ReservationCombination,
  reservationCombinationSchema,
  reservationCombinationsResponseSchema,
  type ReservationTable,
  reservationTableSchema,
  reservationTablesResponseSchema,
  type UpdateCombinationRequest,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Calls of Settings → Reservations (docs/modules/reservations.md → R1.5 setup API). */

export const loadRuleTables = (
  store: Api,
  locationId: string,
): Promise<Result<ReservationTable[]>> =>
  read(
    store,
    `/api/v1/reservations/tables?locationId=${encodeURIComponent(locationId)}`,
    list(reservationTablesResponseSchema),
  );

export const putTableRule = (
  store: Api,
  action: ActionKey,
  tableId: string,
  body: PutTableRuleRequest,
): Promise<Result<ReservationTable | null>> =>
  write(
    store,
    action,
    `/api/v1/reservations/tables/${tableId}/rule`,
    'PUT',
    body,
    reservationTableSchema,
  );

export const loadCombinations = (
  store: Api,
  locationId: string,
  includeArchived: boolean,
): Promise<Result<ReservationCombination[]>> =>
  read(
    store,
    `/api/v1/reservations/combinations?locationId=${encodeURIComponent(locationId)}${includeArchived ? '&includeArchived=true' : ''}`,
    list(reservationCombinationsResponseSchema),
  );

export const createCombination = (
  store: Api,
  action: ActionKey,
  body: CreateCombinationRequest,
): Promise<Result<ReservationCombination | null>> =>
  write(
    store,
    action,
    '/api/v1/reservations/combinations',
    'POST',
    body,
    reservationCombinationSchema,
  );

export const updateCombination = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdateCombinationRequest,
): Promise<Result<ReservationCombination | null>> =>
  write(
    store,
    action,
    `/api/v1/reservations/combinations/${id}`,
    'PATCH',
    body,
    reservationCombinationSchema,
  );
