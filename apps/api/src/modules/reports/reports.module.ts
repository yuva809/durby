import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { PosModule } from '../pos';
import { ReservationsModule } from '../reservations';
import { FactsReader } from './facts-reader';
import { ReportsProjectionHandler } from './projection.handler';
import { ReportsProjection } from './projection.service';
import { ReportsRebuild } from './rebuild.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** Reports (docs/modules/reports.md, ADR 0081). Reads pos, reservations and catalog only through their index. */
@Module({
  imports: [CatalogModule, PosModule, ReservationsModule],
  controllers: [ReportsController],
  providers: [
    FactsReader,
    ReportsProjection,
    ReportsProjectionHandler,
    ReportsRebuild,
    ReportsService,
  ],
  exports: [ReportsRebuild],
})
export class ReportsModule {}
