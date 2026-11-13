import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { type AddDiscountRequest, addDiscountRequestSchema, type Discount } from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodBody } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RequirePermission } from '../../platform/rbac';
import { DiscountsService } from './discounts.service';
import { posErrors } from './pos-errors';

/** Discounts and comps on an order (docs/modules/pos.md → Step 4b, ADR 0036 §5). Writes complete their key in the transaction. */
@RequireFeature('pos')
@Controller('pos/orders/:id/discounts')
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  @RequirePermission('pos.orders.discount')
  @Idempotent({ completion: 'transaction' })
  @Post()
  add(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound })) id: string,
    @Body(new ZodBody(addDiscountRequestSchema)) body: AddDiscountRequest,
  ): Promise<Discount> {
    return this.discounts.add(id, body);
  }

  @RequirePermission('pos.orders.discount')
  @Idempotent({ completion: 'transaction' })
  @Post(':discountId/void')
  remove(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: posErrors.orderNotFound })) id: string,
    @Param('discountId', new ParseUUIDPipe({ exceptionFactory: posErrors.discountNotFound }))
    discountId: string,
  ): Promise<Discount> {
    return this.discounts.remove(id, discountId);
  }
}
