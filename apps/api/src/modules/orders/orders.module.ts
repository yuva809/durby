import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { OrdersController } from './orders.controller';
import { SalesOrdersService } from './sales-orders.service';

/** Orders (docs/modules/orders.md, ADR 0044): customers and sales orders of stock items. */
@Module({
  controllers: [OrdersController],
  providers: [CustomersService, SalesOrdersService],
})
export class OrdersModule {}
