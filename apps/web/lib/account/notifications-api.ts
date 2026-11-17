import {
  type NotificationPreference,
  notificationPreferencesResponseSchema,
  type PutNotificationPreferences,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Your choices per kind of update (docs/platform/notifications.md, ADR 0047). */
export const loadNotificationPreferences = (
  store: Api,
): Promise<Result<NotificationPreference[]>> =>
  read(store, '/api/v1/notifications/preferences', list(notificationPreferencesResponseSchema));

export const saveNotificationPreferences = (
  store: Api,
  action: ActionKey,
  body: PutNotificationPreferences,
): Promise<Result<NotificationPreference[] | null>> =>
  write(
    store,
    action,
    '/api/v1/notifications/preferences',
    'PUT',
    body,
    list(notificationPreferencesResponseSchema),
  );
