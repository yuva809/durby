import { Module } from '@nestjs/common';
import { CatalogModule } from './modules/catalog';
import { PosModule } from './modules/pos';
import { ReservationsModule } from './modules/reservations';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [PlatformModule, CatalogModule, PosModule, ReservationsModule],
})
export class AppModule {}
