import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory';
import { CustomersService } from './customers.service';
import { OrdersController } from './orders.controller';
import { OrdersLookup } from './orders-lookup.service';
import { SalesOrdersService } from './sales-orders.service';
import { StockRequestsController } from './stock-requests.controller';
import { StockRequestsService } from './stock-requests.service';

/** Orders (docs/modules/orders.md, ADR 0044): customers and sales orders of stock items. */
@Module({
  imports: [InventoryModule],
  controllers: [OrdersController, StockRequestsController],
  providers: [CustomersService, SalesOrdersService, StockRequestsService, OrdersLookup],
  exports: [OrdersLookup],
})
export class OrdersModule {}
