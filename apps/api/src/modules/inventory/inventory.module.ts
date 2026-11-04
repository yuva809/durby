import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { ConsumptionHandler } from './consumption.handler';
import { InventoryController } from './inventory.controller';
import { RecipesService } from './recipes.service';
import { InventorySetupService } from './setup.service';
import { StockService } from './stock.service';

/**
 * Inventory (docs/modules/inventory.md): warehouses, stock items, the stock ledger, recipes and
 * the consumption of table-service sales.
 */
@Module({
  imports: [CatalogModule],
  controllers: [InventoryController],
  providers: [InventorySetupService, StockService, RecipesService, ConsumptionHandler],
})
export class InventoryModule {}
