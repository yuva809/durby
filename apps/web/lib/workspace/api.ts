import {
  type AttentionKind,
  type AttentionResponse,
  attentionResponseSchema,
  type SearchResult,
  searchResponseSchema,
} from '@durby/shared';
import { type Api, list, read, type Result } from '../api-call';

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

/** `requests_to_approve` → `requestsToApprove`: label keys are camelCase. */
export const camel = (value: string) =>
  value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
