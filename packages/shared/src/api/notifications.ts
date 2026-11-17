import { z } from 'zod';

/**
 * Stored notifications (docs/platform/notifications.md, ADR 0047): one row per person and event, written in the
 * transaction of the change. The bell lists them (unread first count); email and browser push follow each person's
 * choices per kind. `params` hold what the text needs (numbers, names), never free text or contact details.
 */

export const NOTIFICATION_KINDS = [
  'request_submitted',
  'request_approved',
  'request_rejected',
  'request_driver_assigned',
  'request_on_the_way',
  'request_short',
  'sales_confirmed',
  'sales_packed',
  'sales_returned',
  'low_stock',
  'feedback_answered',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_ENTITY_TYPES = [
  'stock_request',
  'sales_order',
  'stock_item',
  'feedback',
] as const;
export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Kinds emailed unless the person turns it off: what needs them or is assigned to them. */
export const NOTIFICATION_EMAIL_BY_DEFAULT: readonly NotificationKind[] = [
  'request_submitted',
  'request_driver_assigned',
];

export const NOTIFICATION_LIST_LIMIT = 30;

const params = z.record(z.string().max(40), z.string().max(200));

export const notificationSchema = z.object({
  id: z.uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  entityType: z.enum(NOTIFICATION_ENTITY_TYPES),
  entityId: z.uuid(),
  params,
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const notificationListResponseSchema = z.object({
  data: z.array(notificationSchema),
  /** Unread notifications of the person in this organization (not only those listed). */
  unread: z.int().min(0),
});

export const notificationPreferenceSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  email: z.boolean(),
  push: z.boolean(),
});

export const notificationPreferencesResponseSchema = z.object({
  data: z.array(notificationPreferenceSchema),
});

export const putNotificationPreferencesSchema = z.strictObject({
  preferences: z
    .array(
      z.strictObject({ kind: z.enum(NOTIFICATION_KINDS), email: z.boolean(), push: z.boolean() }),
    )
    .min(1)
    .max(NOTIFICATION_KINDS.length),
});

export type Notification = z.infer<typeof notificationSchema>;
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;
export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;
export type PutNotificationPreferences = z.infer<typeof putNotificationPreferencesSchema>;

/** The web page an update leads to (bell, email, push); feedback has none. */
export function notificationPath(
  n: Pick<Notification, 'kind' | 'entityType' | 'entityId'>,
): string | null {
  if (n.kind === 'request_driver_assigned') return '/my-deliveries';
  switch (n.entityType) {
    case 'stock_request':
      return `/requests?open=${n.entityId}`;
    case 'sales_order':
      return `/orders?open=${n.entityId}`;
    case 'stock_item':
      return '/inventory';
    case 'feedback':
      return null;
  }
}

/** Where each person picks email and push per kind. */
export const NOTIFICATION_SETTINGS_PATH = '/account/notifications';

/** A person's choice for a kind, or the default. */
export function defaultPreference(kind: NotificationKind): NotificationPreference {
  return { kind, email: NOTIFICATION_EMAIL_BY_DEFAULT.includes(kind), push: false };
}

export const NOTIFICATION_ERROR_CODES = ['platform.notification_not_found'] as const;
export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];
