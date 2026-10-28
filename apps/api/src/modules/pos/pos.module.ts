import { Module } from '@nestjs/common';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

/** Table service (docs/modules/pos.md): dining tables, orders and kitchen tickets. */
@Module({
  controllers: [TablesController, AreasController, OrdersController],
  providers: [TablesService, AreasService, OrdersService],
  exports: [TablesService, AreasService],
})
export class PosModule {}
