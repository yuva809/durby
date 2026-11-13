import { type AddDiscountRequest, type Discount, discountSchema } from '@durby/shared';
import { type Api, write, type Result } from '../api-call';
import type { ActionKey } from '../idempotency';

/** Discounts and comps on an order (docs/modules/pos.md → Step 4b), parsed with the shared schemas. */

export const addDiscount = (
  store: Api,
  action: ActionKey,
  orderId: string,
  body: AddDiscountRequest,
): Promise<Result<Discount | null>> =>
  write(store, action, `/api/v1/pos/orders/${orderId}/discounts`, 'POST', body, discountSchema);

export const removeDiscount = (
  store: Api,
  action: ActionKey,
  orderId: string,
  discountId: string,
): Promise<Result<Discount | null>> =>
  write(
    store,
    action,
    `/api/v1/pos/orders/${orderId}/discounts/${discountId}/void`,
    'POST',
    {},
    discountSchema,
  );
