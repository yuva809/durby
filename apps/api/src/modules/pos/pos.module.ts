import { PosRealtimeHandler } from './realtime.handler';
import { PosStreamController } from './stream.controller';
import { Module } from '@nestjs/common';
import { OrganizationModule } from '../../platform/organization';
import { CatalogModule } from '../catalog';
import { AreasController } from './areas.controller';
import { AreasService } from './areas.service';
import { BillLayoutController } from './bill-layout.controller';
import { BillLayoutService } from './bill-layout.service';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';
import { DiscountsController } from './discounts.controller';
import { DiscountsService } from './discounts.service';
import { PosFloorReader } from './floor-reader';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrinterCommandsController } from './printer-commands.controller';
import { PrinterCommandsService } from './printer-commands.service';
import { PrintJobsController, StationPrintJobsController } from './print-jobs.controller';
import { PrintJobSweep } from './print-job-sweep';
import { PrintJobsService } from './print-jobs.service';
import { PrintersController } from './printers.controller';
import { PrintersService } from './printers.service';
import { PublicMenuController } from './public-menu.controller';
import { PublicMenuService } from './public-menu.service';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';

/**
 * Table service (docs/modules/pos.md): dining tables, orders, kitchen and bar tickets and screens,
 * bills and guest checks, the bill layout, the public QR menu, remote printer commands for the Android app.
 */
@Module({
  imports: [CatalogModule, OrganizationModule],
  controllers: [
    PosStreamController,
    TablesController,
    AreasController,
    OrdersController,
    BillsController,
    DiscountsController,
    BillLayoutController,
    KitchenController,
    PublicMenuController,
    PrinterCommandsController,
    PrintersController,
    PrintJobsController,
    StationPrintJobsController,
  ],
  providers: [
    TablesService,
    AreasService,
    OrdersService,
    BillsService,
    DiscountsService,
    BillLayoutService,
    KitchenService,
    PublicMenuService,
    PosFloorReader,
    PrinterCommandsService,
    PrintersService,
    PrintJobsService,
    PrintJobSweep,
    PosRealtimeHandler,
  ],
  exports: [TablesService, AreasService, PosFloorReader],
})
export class PosModule {}
