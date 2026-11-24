import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { PosModule } from '../pos';
import { ReservationsModule } from '../reservations';
import { ReportsProjectionHandler } from './projection.handler';
import { ReportsProjection } from './projection.service';
import { ReportsRebuild } from './rebuild.service';

/** Reports (docs/modules/reports.md, ADR 0081). Reads pos, reservations and catalog only through their index. */
@Module({
  imports: [CatalogModule, PosModule, ReservationsModule],
  providers: [ReportsProjection, ReportsProjectionHandler, ReportsRebuild],
  exports: [ReportsRebuild],
})
export class ReportsModule {}
