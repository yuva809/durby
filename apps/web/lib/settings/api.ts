import type { Locale } from '@durby/i18n';
import {
  type LabelOverride,
  labelOverrideSchema,
  labelOverridesResponseSchema,
  labelsResponseSchema,
  locationSchema,
  type MeEntitlementsResponse,
  meEntitlementsResponseSchema,
  type NumberSeries,
  numberSeriesListResponseSchema,
  numberSeriesSchema,
  type Organization,
  organizationSchema,
  type PatchNumberSeriesRequest,
  type ResolvedSetting,
  resolvedSettingSchema,
  type SettingKey,
  settingsResponseSchema,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/**
 * Calls of the settings pages (docs/platform/web-shell.md → Settings, labels, number series,
 * plan, organization). Settings at organization scope, or at a location with `locationId` (the
 * bill page); no brand query yet.
 */

const scoped = (path: string, locationId?: string) =>
  locationId ? `${path}?locationId=${encodeURIComponent(locationId)}` : path;

export const loadSettings = (store: Api, locationId?: string): Promise<Result<ResolvedSetting[]>> =>
  read(store, scoped('/api/v1/settings', locationId), list(settingsResponseSchema));

export const putSetting = (
  store: Api,
  action: ActionKey,
  key: SettingKey,
  value: unknown,
  locationId?: string,
) =>
  write(
    store,
    action,
    scoped(`/api/v1/settings/${key}`, locationId),
    'PUT',
    { value },
    resolvedSettingSchema,
  );

/** Removes the value at the scope: the inherited one applies again. */
export const deleteSetting = (
  store: Api,
  action: ActionKey,
  key: SettingKey,
  locationId?: string,
) => write(store, action, scoped(`/api/v1/settings/${key}`, locationId), 'DELETE');

export const loadLabelOverrides = (store: Api): Promise<Result<LabelOverride[]>> =>
  read(store, '/api/v1/label-overrides', list(labelOverridesResponseSchema));

/** Every label of the organization in `locale`, resolved (override, partner, default). */
export const loadResolvedLabels = (
  store: Api,
  locale: Locale,
): Promise<Result<Record<string, string>>> =>
  read<Record<string, string>>(store, `/api/v1/labels?locale=${locale}`, {
    safeParse: (value: unknown) => {
      const result = labelsResponseSchema.safeParse(value);
      if (!result.success || result.data.locale !== locale) return { success: false as const };
      const data: Record<string, string> = result.data.data;
      return { success: true as const, data };
    },
  });

const overridePath = (locale: string, key: string) =>
  `/api/v1/label-overrides/${encodeURIComponent(locale)}/${encodeURIComponent(key)}`;

export const putLabelOverride = (
  store: Api,
  action: ActionKey,
  locale: string,
  key: string,
  value: string,
) => write(store, action, overridePath(locale, key), 'PUT', { value }, labelOverrideSchema);

export const deleteLabelOverride = (store: Api, action: ActionKey, locale: string, key: string) =>
  write(store, action, overridePath(locale, key), 'DELETE');

export const loadNumberSeries = (store: Api): Promise<Result<NumberSeries[]>> =>
  read(store, '/api/v1/number-series', list(numberSeriesListResponseSchema));

export const patchNumberSeries = (
  store: Api,
  action: ActionKey,
  key: string,
  body: PatchNumberSeriesRequest,
) => write(store, action, `/api/v1/number-series/${key}`, 'PATCH', body, numberSeriesSchema);

export const raiseCounter = (store: Api, action: ActionKey, key: string, nextValue: string) =>
  write(
    store,
    action,
    `/api/v1/number-series/${key}/counter`,
    'PUT',
    { nextValue },
    numberSeriesSchema,
  );

export const loadEntitlements = (store: Api): Promise<Result<MeEntitlementsResponse>> =>
  read(store, '/api/v1/me/entitlements', meEntitlementsResponseSchema);

export const renameOrganization = (store: Api, action: ActionKey, name: string) =>
  write(store, action, '/api/v1/organization', 'PATCH', { name }, organizationSchema);

/** Owner only (platform.org.manage); the list is lib/users/api.ts `loadLocations`. */
export const createLocation = (store: Api, action: ActionKey, name: string) =>
  write(store, action, '/api/v1/locations', 'POST', { name }, locationSchema);

export const renameLocation = (store: Api, action: ActionKey, id: string, name: string) =>
  write(store, action, `/api/v1/locations/${id}`, 'PATCH', { name }, locationSchema);

export const deleteLocation = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `/api/v1/locations/${id}`, 'DELETE');

export type { Organization };
