import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

/** Table service (docs/modules/pos.md): dining tables, orders and kitchen tickets. */
@Module({
  controllers: [TablesController, OrdersController],
  providers: [TablesService, OrdersService],
  exports: [TablesService],
})
export class PosModule {}
