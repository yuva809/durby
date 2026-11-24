import { Module } from '@nestjs/common';
import { CatalogModule } from './modules/catalog';
import { InventoryModule } from './modules/inventory';
import { OrdersModule } from './modules/orders';
import { PosModule } from './modules/pos';
import { ReportsModule } from './modules/reports';
import { ReservationsModule } from './modules/reservations';
import { WorkspaceModule } from './modules/workspace';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [
    PlatformModule,
    CatalogModule,
    InventoryModule,
    OrdersModule,
    PosModule,
    ReservationsModule,
    ReportsModule,
    WorkspaceModule,
  ],
})
export class AppModule {}
