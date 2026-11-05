import {
  type CreatePriceRuleRequest,
  type PriceRule,
  priceRuleListResponseSchema,
  priceRuleSchema,
  type PricesResponse,
  pricesResponseSchema,
  type UpdatePriceRuleRequest,
} from '@durby/shared';
import { type Api, list, read, type Result, write } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Price rules and effective prices (docs/modules/catalog.md → Price rules, ADR 0030). */

const BASE = '/api/v1/catalog';

export const loadPriceRules = (store: Api): Promise<Result<PriceRule[]>> =>
  read(store, `${BASE}/price-rules`, list(priceRuleListResponseSchema));

export const createPriceRule = (store: Api, action: ActionKey, body: CreatePriceRuleRequest) =>
  write(store, action, `${BASE}/price-rules`, 'POST', body, priceRuleSchema);

export const updatePriceRule = (
  store: Api,
  action: ActionKey,
  id: string,
  body: UpdatePriceRuleRequest,
) => write(store, action, `${BASE}/price-rules/${id}`, 'PATCH', body, priceRuleSchema);

export const deletePriceRule = (store: Api, action: ActionKey, id: string) =>
  write(store, action, `${BASE}/price-rules/${id}`, 'DELETE');

/** What each product costs at a location now, at `at`, or without time rules (`timed: false`). */
export const loadPrices = (
  store: Api,
  locationId: string,
  options: { at?: string; timed?: boolean } = {},
): Promise<Result<PricesResponse>> => {
  const search = new URLSearchParams({ locationId });
  if (options.at) search.set('at', options.at);
  if (options.timed === false) search.set('timed', 'false');
  return read(store, `${BASE}/prices?${search.toString()}`, pricesResponseSchema);
};
