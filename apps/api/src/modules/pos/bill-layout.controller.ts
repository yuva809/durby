import { Controller, Get, Query } from '@nestjs/common';
import { type BillLayout, type BillLayoutQuery, billLayoutQuerySchema } from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodQuery } from '../../platform/http';
import { RequirePermission } from '../../platform/rbac';
import { BillLayoutService } from './bill-layout.service';

/**
 * The bill's header and footer for the till (docs/modules/pos.md → Bill layout). The guard checks
 * the key for some location; the service checks it at the requested one. Edited through the
 * settings API (`pos.billHeader`, `pos.billFooter`).
 */
@RequireFeature('pos')
@Controller('pos')
export class BillLayoutController {
  constructor(private readonly layouts: BillLayoutService) {}

  @RequirePermission('pos.bills.print')
  @Get('bill-layout')
  layout(@Query(new ZodQuery(billLayoutQuerySchema)) query: BillLayoutQuery): Promise<BillLayout> {
    return this.layouts.at(query.locationId);
  }
}
