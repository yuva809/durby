import { Module } from '@nestjs/common';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';
import { BillLayoutController } from './bill-layout.controller';
import { BillLayoutService } from './bill-layout.service';
import { PosFloorReader } from './floor-reader';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

/** Table service (docs/modules/pos.md): dining tables, orders, kitchen and bar tickets, the bill layout. */
@Module({
  controllers: [TablesController, AreasController, OrdersController, BillLayoutController],
  providers: [TablesService, AreasService, OrdersService, BillLayoutService, PosFloorReader],
  exports: [TablesService, AreasService, PosFloorReader],
})
export class PosModule {}
