import {
  type AttentionKind,
  type AttentionResponse,
  attentionResponseSchema,
  type NotificationListResponse,
  notificationListResponseSchema,
  notificationPath,
  type SearchResult,
  searchResponseSchema,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import { ActionKey } from '../idempotency';

/** The top bar's calls (ADR 0046) and where each result or item leads. */

export const loadSearch = (store: Api, q: string): Promise<Result<SearchResult[]>> =>
  read(store, `/api/v1/search?q=${encodeURIComponent(q)}`, list(searchResponseSchema));

export const loadAttention = (store: Api): Promise<Result<AttentionResponse>> =>
  read(store, '/api/v1/attention', attentionResponseSchema);

/** The page a search result opens; orders and requests open in their side panel (`?open=`). */
export function resultHref(result: Pick<SearchResult, 'type' | 'id'>): string {
  switch (result.type) {
    case 'stock_item':
      return '/inventory';
    case 'product':
      return '/catalog';
    case 'customer':
      return '/orders/customers';
    case 'sales_order':
      return `/orders?open=${result.id}`;
    case 'stock_request':
      return `/requests?open=${result.id}`;
    case 'member':
      return '/staff';
  }
}

/** Where a "waiting for me" item is dealt with. */
export const ATTENTION_HREF: Readonly<Record<AttentionKind, string>> = {
  requests_to_approve: '/requests',
  transfers_to_pick: '/picking',
  my_deliveries: '/my-deliveries',
  goods_to_receive: '/requests',
  sales_to_pick: '/picking',
  sales_to_dispatch: '/deliveries',
  draft_orders: '/orders',
  low_stock: '/inventory',
};

// --- Updates: stored notifications (ADR 0047) ------------------------------------------------------------------

export const loadNotifications = (store: Api): Promise<Result<NotificationListResponse>> =>
  read(store, '/api/v1/notifications', notificationListResponseSchema);

/** Each click is its own action: a fresh key per call. */
export const markNotificationRead = (store: Api, id: string) =>
  write(store, new ActionKey(), `/api/v1/notifications/${id}/read`, 'POST');

export const markAllNotificationsRead = (store: Api) =>
  write(store, new ActionKey(), '/api/v1/notifications/read-all', 'POST');

/** Where an update leads (shared with the email and push links). */
export const notificationHref = notificationPath;

/** `requests_to_approve` → `requestsToApprove`: label keys are camelCase. */
export const camel = (value: string) =>
  value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
