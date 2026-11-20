import { z } from 'zod';

/**
 * The top bar's search and "waiting for me" (docs/platform/web-shell.md → Search and notifications, ADR 0046). Both
 * answer only what the signed-in person may see; the web turns a result or an item into a link.
 */

export const SEARCH_RESULT_TYPES = [
  'stock_item',
  'warehouse',
  'branch',
  'product',
  'customer',
  'sales_order',
  'stock_request',
  'member',
] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

/** At most this many results per type. */
export const SEARCH_LIMIT_PER_TYPE = 5;

export const searchQuerySchema = z.object({ q: z.string().trim().min(2).max(100) });

export const searchResultSchema = z.object({
  type: z.enum(SEARCH_RESULT_TYPES),
  id: z.string(),
  title: z.string(),
  /** A second line: SKU, customer, branch, status… */
  subtitle: z.string().nullable(),
});

export const searchResponseSchema = z.object({ data: z.array(searchResultSchema) });

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;

/** Kinds of "waiting for me" items, each for those who can act on it. */
export const ATTENTION_KINDS = [
  'requests_to_approve',
  'transfers_to_pick',
  'my_deliveries',
  'goods_to_receive',
  'sales_to_pick',
  'sales_to_dispatch',
  'draft_orders',
  'low_stock',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const attentionItemSchema = z.object({
  kind: z.enum(ATTENTION_KINDS),
  count: z.int().min(1),
});

export const attentionResponseSchema = z.object({
  /** Only kinds with something waiting, in ATTENTION_KINDS order. */
  data: z.array(attentionItemSchema),
  total: z.int().min(0),
});

export type AttentionItem = z.infer<typeof attentionItemSchema>;
export type AttentionResponse = z.infer<typeof attentionResponseSchema>;
