import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { BomsService } from './boms.service';
import { ConsumptionHandler } from './consumption.handler';
import { InventoryController } from './inventory.controller';
import { ItemSetupController } from './item-setup.controller';
import { RecipesService } from './recipes.service';
import { InventorySetupService } from './setup.service';
import { StockService } from './stock.service';
import { UnitsService } from './units.service';
import { VariantsService } from './variants.service';

/**
 * Inventory (docs/modules/inventory.md): warehouses, stock items, the stock ledger, recipes and
 * the consumption of table-service sales; units, variants, bills of materials and production (Step 5).
 */
@Module({
  imports: [CatalogModule],
  controllers: [InventoryController, ItemSetupController],
  providers: [
    InventorySetupService,
    StockService,
    RecipesService,
    ConsumptionHandler,
    UnitsService,
    VariantsService,
    BomsService,
  ],
  // Sales orders book their goods out and back in through it (orders module, ADR 0044).
  exports: [StockService],
})
export class InventoryModule {}
