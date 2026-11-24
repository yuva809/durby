import { Controller, Get, Query } from '@nestjs/common';
import {
  type OverviewResponse,
  type ReportQuery,
  reportQuerySchema,
  type ReservationsReportResponse,
  type SalesCategoriesResponse,
  type SalesHoursResponse,
  type SalesItemsResponse,
  type SalesSummaryResponse,
  type TablesReportResponse,
} from '@durby/shared';
import { RequireFeature } from '../../platform/config/entitlements';
import { ZodQuery } from '../../platform/http';
import { RequirePermission } from '../../platform/rbac';
import { ReportsService } from './reports.service';

/** /api/v1/reports (docs/modules/reports.md → Routes). Reads only. */
@RequireFeature('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequireFeature('pos')
  @RequirePermission('reports.sales.read')
  @Get('overview')
  overview(): Promise<OverviewResponse> {
    return this.reports.overview();
  }

  @RequireFeature('pos')
  @RequirePermission('reports.sales.read')
  @Get('sales/summary')
  summary(
    @Query(new ZodQuery(reportQuerySchema)) query: ReportQuery,
  ): Promise<SalesSummaryResponse> {
    return this.reports.summary(query);
  }

  @RequireFeature('pos')
  @RequirePermission('reports.sales.read')
  @Get('sales/hours')
  hours(@Query(new ZodQuery(reportQuerySchema)) query: ReportQuery): Promise<SalesHoursResponse> {
    return this.reports.hours(query);
  }

  @RequireFeature('pos')
  @RequirePermission('reports.sales.read')
  @Get('sales/items')
  items(@Query(new ZodQuery(reportQuerySchema)) query: ReportQuery): Promise<SalesItemsResponse> {
    return this.reports.items(query);
  }

  @RequireFeature('pos')
  @RequirePermission('reports.sales.read')
  @Get('sales/categories')
  categories(
    @Query(new ZodQuery(reportQuerySchema)) query: ReportQuery,
  ): Promise<SalesCategoriesResponse> {
    return this.reports.categories(query);
  }

  @RequireFeature('pos')
  @RequirePermission('reports.sales.read')
  @Get('tables')
  tables(
    @Query(new ZodQuery(reportQuerySchema)) query: ReportQuery,
  ): Promise<TablesReportResponse> {
    return this.reports.tables(query);
  }

  @RequireFeature('reservations')
  @RequirePermission('reports.reservations.read')
  @Get('reservations')
  reservations(
    @Query(new ZodQuery(reportQuerySchema)) query: ReportQuery,
  ): Promise<ReservationsReportResponse> {
    return this.reports.reservations(query);
  }
}
