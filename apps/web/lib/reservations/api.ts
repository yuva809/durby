import {
  bookingPageResponseSchema,
  bookingPageSchema,
  type CreateCombinationRequest,
  type PutBookingPageRequest,
  type PutTableRuleRequest,
  type ReservationCombination,
  reservationCombinationSchema,
  reservationCombinationsResponseSchema,
  type ReservationSettingsResponse,
  reservationSettingsResponseSchema,
  type ReservationTable,
  type ResolvedSetting,
  resolvedSettingSchema,
  type SettingKey,
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

/** The location's reservations settings (R1.5c, ADR 0020). */

export const loadLocationSettings = (
  store: Api,
  locationId: string,
): Promise<Result<ReservationSettingsResponse>> =>
  read(
    store,
    `/api/v1/reservations/settings?locationId=${encodeURIComponent(locationId)}`,
    reservationSettingsResponseSchema,
  );

export const putLocationSetting = (
  store: Api,
  action: ActionKey,
  locationId: string,
  key: SettingKey,
  value: unknown,
): Promise<Result<ResolvedSetting | null>> =>
  write(
    store,
    action,
    `/api/v1/reservations/settings/${key}?locationId=${encodeURIComponent(locationId)}`,
    'PUT',
    { value },
    resolvedSettingSchema,
  );

export const deleteLocationSetting = (
  store: Api,
  action: ActionKey,
  locationId: string,
  key: SettingKey,
): Promise<Result<null>> =>
  write(
    store,
    action,
    `/api/v1/reservations/settings/${key}?locationId=${encodeURIComponent(locationId)}`,
    'DELETE',
  );

/** The location's online booking page (R2.1). */
export const loadBookingPage = (store: Api, locationId: string) =>
  read(
    store,
    `/api/v1/reservations/booking-page?${new URLSearchParams({ locationId })}`,
    bookingPageResponseSchema,
  );

export const saveBookingPage = (store: Api, action: ActionKey, body: PutBookingPageRequest) =>
  write(store, action, '/api/v1/reservations/booking-page', 'PUT', body, bookingPageSchema);
