import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { PosModule } from '../pos';
import { ReservationsModule } from '../reservations';
import { DailyReportScheduler } from './daily-report.scheduler';
import { DailyReport } from './daily-report.service';
import { DayFigures } from './day-figures';
import { FactsReader } from './facts-reader';
import { ReportPlaces } from './places';
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
    DailyReport,
    DailyReportScheduler,
    DayFigures,
    FactsReader,
    ReportPlaces,
    ReportsProjection,
    ReportsProjectionHandler,
    ReportsRebuild,
    ReportsService,
  ],
  exports: [DailyReport, DailyReportScheduler, ReportsRebuild],
})
export class ReportsModule {}
