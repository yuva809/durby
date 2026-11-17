import { z } from 'zod';

/** Most notification ids per event: keeps the payload well under EVENT_PAYLOAD_MAX_BYTES (~40 bytes each). */
export const NOTIFICATION_EVENT_MAX_IDS = 150;

/**
 * Notifications were stored (docs/platform/notifications.md, ADR 0047), written with them in the change's transaction.
 * Consumer: the worker emails and pushes them to the people who chose that for the kind. Ids only: who and what are
 * read from the rows.
 */
export const platformNotificationCreatedV1 = z.strictObject({
  notificationIds: z.array(z.uuid()).min(1).max(NOTIFICATION_EVENT_MAX_IDS),
});
