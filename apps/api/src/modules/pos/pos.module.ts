import { Module } from '@nestjs/common';
import { OrganizationModule } from '../../platform/organization';
import { CatalogModule } from '../catalog';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';
import { BillLayoutController } from './bill-layout.controller';
import { BillLayoutService } from './bill-layout.service';
import { PosFloorReader } from './floor-reader';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PublicMenuController } from './public-menu.controller';
import { PublicMenuService } from './public-menu.service';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

/**
 * Table service (docs/modules/pos.md): dining tables, orders, kitchen and bar tickets and screens,
 * the bill layout, the public QR menu.
 */
@Module({
  imports: [CatalogModule, OrganizationModule],
  controllers: [
    TablesController,
    AreasController,
    OrdersController,
    BillLayoutController,
    KitchenController,
    PublicMenuController,
  ],
  providers: [
    TablesService,
    AreasService,
    OrdersService,
    BillLayoutService,
    KitchenService,
    PublicMenuService,
    PosFloorReader,
  ],
  exports: [TablesService, AreasService, PosFloorReader],
})
export class PosModule {}
