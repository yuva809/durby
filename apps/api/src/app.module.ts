import { Module } from '@nestjs/common';
import { CatalogModule } from './modules/catalog';
import { InventoryModule } from './modules/inventory';
import { PosModule } from './modules/pos';
import { ReservationsModule } from './modules/reservations';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [PlatformModule, CatalogModule, InventoryModule, PosModule, ReservationsModule],
})
export class AppModule {}
