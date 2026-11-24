import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  type OverviewResponse,
  type PermissionKey,
  type ReportQuery,
  type ReservationsReportResponse,
  SALES_CARDS,
  type SalesCategoriesResponse,
  type SalesHoursResponse,
  type SalesItemsResponse,
  type SalesSummaryResponse,
  type TablesReportResponse,
  TURN_TIME_BANDS,
} from '@durby/shared';
import { Clock } from '../../platform/auth';
import { SettingsService } from '../../platform/config/settings';
import { ApiError } from '../../platform/http';
import { AccessService } from '../../platform/rbac';
import {
  asTenantDb,
  TENANT_PRISMA,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from '../../platform/tenancy';
import { CatalogLookup } from '../catalog';
import { PosFloorReader } from '../pos';
import { DayFigures } from './day-figures';
import { FactsReader, spansOf } from './facts-reader';
import {
  addSales,
  changePercent,
  METRIC,
  NO_SALES,
  percent,
  salesFigures,
  type SalesSums,
} from './metrics';
import { type CardSpans, cardSpans, daysSpan, lastDay, type Span } from './periods';
import { ACTIVE_BRANCHES, type Place, ReportPlaces } from './places';

const locationNotFound = () =>
  new ApiError(HttpStatus.NOT_FOUND, 'reports.location_not_found', 'Location not found.');

/**
 * The reports (docs/modules/reports.md, ADR 0081). Each is read in one read-only snapshot. The guard checks the key for
 * some location; here it narrows the report to the caller's locations.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly facts: FactsReader,
    private readonly catalog: CatalogLookup,
    private readonly floor: PosFloorReader,
    private readonly places: ReportPlaces,
    private readonly days: DayFigures,
  ) {}

  /** The home page (ADR 0082): active locations now, and yesterday against their normal day. */
  overview(): Promise<OverviewResponse> {
    const now = this.clock.now();
    return this.read(
      'reports.sales.read',
      {},
      async (places, tx) => {
        const at = (span: (place: Place) => Span) => this.facts.sales(spansOf(places, span), tx);
        const today = await at(({ clock }) => cardSpans(now, clock).today.figures);
        const lastWeek = await at(({ clock }) => cardSpans(now, clock).today.compare);
        const past = await this.days.of(places, ({ clock }) => lastDay(now, clock), tx);
        const openTables = new Map<string, number>();
        for (const { locationId } of places) {
          openTables.set(locationId, (await this.floor.openOrders(locationId, tx)).length);
        }
        const part = (sales: SalesSums, lastWeekSales: SalesSums, open: number) => ({
          ...salesFigures(sales),
          openTables: open,
          changePercent: changePercent(sales.gross, lastWeekSales.gross),
        });
        const pastSales = (sales: SalesSums) => ({
          gross: METRIC['sales.gross']({ sales }),
          orders: METRIC['sales.orders']({ sales }),
        });
        return {
          currency: await this.settings.get('currency', {}, tx),
          asOf: now.toISOString(),
          hasData: await this.facts.any(
            places.map((p) => p.locationId),
            tx,
          ),
          total: {
            today: part(
              addSales(today.values()),
              addSales(lastWeek.values()),
              [...openTables.values()].reduce((sum, n) => sum + n, 0),
            ),
            yesterday: {
              ...pastSales(past.total.sales),
              normal: past.total.normal,
              leftOut: past.total.leftOut,
            },
          },
          locations: past.places.map(
            ({ place: { locationId, name }, day, sales, days, normal }) => ({
              locationId,
              name,
              today: part(
                today.get(locationId) ?? NO_SALES,
                lastWeek.get(locationId) ?? NO_SALES,
                openTables.get(locationId) ?? 0,
              ),
              yesterday: { day, ...pastSales(sales), normal: normal && { ...normal, days } },
            }),
          ),
        };
      },
      ACTIVE_BRANCHES,
    );
  }

  summary(query: ReportQuery): Promise<SalesSummaryResponse> {
    const now = this.clock.now();
    return this.read('reports.sales.read', query, async (places, tx) => {
      const cards = [];
      for (const key of SALES_CARDS) {
        const at = (part: keyof CardSpans) =>
          this.total(places, ({ clock }) => cardSpans(now, clock)[key][part], tx);
        const figures = await at('figures');
        const compare = await at('compare');
        cards.push({
          key,
          figures: salesFigures(figures),
          compare: salesFigures(compare),
          changePercent: changePercent(figures.gross, compare.gross),
        });
      }
      const period = await this.total(places, periodOf(query), tx);
      return {
        currency: await this.settings.get('currency', {}, tx),
        cards,
        period: {
          ...salesFigures(period),
          secondRoundOrders: period.secondRoundOrders,
          secondRoundRate: METRIC['sales.secondRoundRate']({ sales: period }),
        },
      };
    });
  }

  hours(query: ReportQuery): Promise<SalesHoursResponse> {
    return this.read('reports.sales.read', query, async (places, tx) => {
      const rows = await this.facts.hours(spansOf(places, periodOf(query)), tx);
      const byHour = new Map(rows.map((r) => [r.hour, r]));
      return {
        currency: await this.settings.get('currency', {}, tx),
        data: Array.from(
          { length: 24 },
          (_, hour) => byHour.get(hour) ?? { hour, gross: '0.00', items: 0, orders: 0 },
        ),
      };
    });
  }

  items(query: ReportQuery): Promise<SalesItemsResponse> {
    return this.read('reports.sales.read', query, async (places, tx) => {
      const rows = await this.facts.products(spansOf(places, periodOf(query)), tx);
      const products = await this.catalog.productsByIds(
        rows.map((r) => r.productId),
        asTenantDb(tx),
      );
      return {
        currency: await this.settings.get('currency', {}, tx),
        data: rows.flatMap((row) => {
          const product = products.get(row.productId);
          return product
            ? [{ ...row, name: product.name, categoryName: product.categoryName }]
            : [];
        }),
      };
    });
  }

  categories(query: ReportQuery): Promise<SalesCategoriesResponse> {
    return this.read('reports.sales.read', query, async (places, tx) => {
      const rows = await this.facts.products(spansOf(places, periodOf(query)), tx);
      const products = await this.catalog.productsByIds(
        rows.map((r) => r.productId),
        asTenantDb(tx),
      );
      const byCategory = new Map<string, { name: string; quantity: number; gross: Decimal }>();
      let total = new Decimal(0);
      for (const row of rows) {
        const product = products.get(row.productId);
        if (!product) continue;
        total = total.plus(row.gross);
        const sum = byCategory.get(product.categoryId);
        byCategory.set(product.categoryId, {
          name: product.categoryName,
          quantity: (sum?.quantity ?? 0) + row.quantity,
          gross: (sum?.gross ?? new Decimal(0)).plus(row.gross),
        });
      }
      return {
        currency: await this.settings.get('currency', {}, tx),
        data: [...byCategory]
          .sort(([, a], [, b]) => b.gross.comparedTo(a.gross) || a.name.localeCompare(b.name))
          .map(([categoryId, c]) => ({
            categoryId,
            name: c.name,
            quantity: c.quantity,
            gross: c.gross.toFixed(2),
            share: percent(c.gross, total),
          })),
      };
    });
  }

  tables(query: ReportQuery): Promise<TablesReportResponse> {
    return this.read('reports.sales.read', query, async (places, tx) => {
      const rows = await this.facts.tables(spansOf(places, periodOf(query)), tx);
      const open = [];
      for (const { locationId } of places) {
        for (const order of await this.floor.openOrders(locationId, tx)) {
          open.push({ locationId, ...order });
        }
      }
      const named = new Map(
        (
          await this.floor.tables(
            [...rows.map((r) => r.tableId), ...open.map((o) => o.tableId)],
            tx,
          )
        ).map((t) => [t.id, t]),
      );
      const sum = {
        orders: rows.reduce((n, r) => n + r.orders, 0),
        seconds: rows.reduce((n, r) => n + r.seconds, 0),
        open: open.length,
      };
      return {
        orders: sum.orders,
        averageMinutes: METRIC['tables.averageMinutes']({ tables: sum }),
        tables: rows
          .flatMap((row) => {
            const table = named.get(row.tableId);
            const averageMinutes = METRIC['tables.averageMinutes']({
              tables: { orders: row.orders, seconds: row.seconds, open: 0 },
            });
            return table && averageMinutes !== null
              ? [
                  {
                    tableId: table.id,
                    locationId: table.locationId,
                    name: table.name,
                    orders: row.orders,
                    averageMinutes,
                  },
                ]
              : [];
          })
          .sort((a, b) => b.averageMinutes - a.averageMinutes || a.name.localeCompare(b.name)),
        open: open
          .map((o) => ({
            tableId: o.tableId,
            locationId: o.locationId,
            name: named.get(o.tableId)?.name ?? '',
            openedAt: o.openedAt.toISOString(),
            covers: o.covers,
          }))
          .sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
      };
    });
  }

  reservations(query: ReportQuery): Promise<ReservationsReportResponse> {
    return this.read('reports.reservations.read', query, async (places, tx) => {
      const { total, bands } = await this.facts.reservations(spansOf(places, periodOf(query)), tx);
      const sums = { reservations: total };
      return {
        covers: METRIC['reservations.covers'](sums),
        walkInCovers: total.walkInCovers,
        kept: total.kept,
        noShows: total.noShows,
        noShowRate: METRIC['reservations.noShowRate'](sums),
        turnMinutes: METRIC['reservations.turnMinutes'](sums),
        turnTimes: TURN_TIME_BANDS.map((band, i) => ({
          ...band,
          bookings: bands[i]?.bookings ?? 0,
          minutes: METRIC['reservations.turnMinutes']({
            reservations: {
              ...total,
              turns: bands[i]?.bookings ?? 0,
              turnSeconds: bands[i]?.seconds ?? 0,
            },
          }),
        })),
      };
    });
  }

  /** Sums over all places, each over its own span. */
  private async total(places: Place[], span: (place: Place) => Span, tx: TenantTransactionClient) {
    return addSales((await this.facts.sales(spansOf(places, span), tx)).values());
  }

  /** One read-only snapshot over the caller's locations, or the one asked for (404 when they can't read it). */
  private async read<T>(
    key: PermissionKey,
    query: { locationId?: string | undefined },
    fn: (places: Place[], tx: TenantTransactionClient) => Promise<T>,
    only: { archivedAt?: null; isWarehouseSite?: false } = {},
  ): Promise<T> {
    const scope = await this.access.locationIdsFor(key);
    // Loaded once for the request, so each location's settings below cost no further read of the stored values.
    await this.settings.get('timezone');
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const places = await this.places.load(
          {
            ...only,
            ...(scope === 'all' ? {} : { id: { in: scope } }),
            ...(query.locationId ? { AND: { id: query.locationId } } : {}),
          },
          tx,
        );
        if (query.locationId && places.length === 0) throw locationNotFound();
        return fn(places, tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

const periodOf =
  (query: ReportQuery) =>
  ({ clock }: Place): Span =>
    daysSpan(query.from, query.to, clock);
