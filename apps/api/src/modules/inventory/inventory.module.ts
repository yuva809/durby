import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventorySetupService } from './setup.service';
import { StockService } from './stock.service';

/** Inventory (docs/modules/inventory.md): warehouses, stock items and the stock ledger. */
@Module({
  controllers: [InventoryController],
  providers: [InventorySetupService, StockService],
})
export class InventoryModule {}
