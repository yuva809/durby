import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  type DayClock,
  type OverviewResponse,
  NORMAL_DAY_WEEKS,
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
import { FactsReader, type LocationSpan } from './facts-reader';
import {
  addSales,
  changePercent,
  METRIC,
  NO_SALES,
  type NormalDaySums,
  percent,
  salesFigures,
  type SalesSums,
} from './metrics';
import { type CardSpans, cardSpans, daysSpan, normalDay, type Span } from './periods';

const locationNotFound = () =>
  new ApiError(HttpStatus.NOT_FOUND, 'reports.location_not_found', 'Location not found.');

/** A location the caller may read, and where its business days start. */
interface Place {
  locationId: string;
  name: string;
  clock: DayClock;
}

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
  ) {}

  /** The home page (ADR 0082): active locations now, and yesterday against their normal day. */
  overview(): Promise<OverviewResponse> {
    const now = this.clock.now();
    return this.read(
      'reports.sales.read',
      {},
      async (places, tx) => {
        const at = (span: (place: Place) => Span) => this.facts.sales(spans(places, span), tx);
        const today = await at(({ clock }) => cardSpans(now, clock).today.figures);
        const lastWeek = await at(({ clock }) => cardSpans(now, clock).today.compare);
        const yesterday = await at(({ clock }) => normalDay(now, clock).yesterday);
        const before: Map<string, SalesSums>[] = [];
        for (let week = 0; week < NORMAL_DAY_WEEKS; week += 1) {
          before.push(await at(({ clock }) => normalDay(now, clock).before[week]!));
        }
        const rows = [];
        for (const { locationId, name, clock } of places) {
          const of = (sums: Map<string, SalesSums>) => sums.get(locationId) ?? NO_SALES;
          // A day without orders says nothing about a normal one: closed, or not open yet.
          const days = before.map(of).filter((day) => day.orders > 0);
          rows.push({
            locationId,
            name,
            day: normalDay(now, clock).day,
            today: of(today),
            lastWeek: of(lastWeek),
            openTables: (await this.floor.openOrders(locationId, tx)).length,
            yesterday: of(yesterday),
            days: days.length,
            normal: normalOf({
              gross: addSales(days).gross,
              days: days.length,
              yesterday: of(yesterday).gross,
            }),
          });
        }
        const compared = rows.flatMap(({ normal, yesterday: { gross } }) =>
          normal ? [{ normal, gross }] : [],
        );
        const comparedGross = compared.reduce((sum, r) => sum.plus(r.gross), new Decimal(0));
        const all = addSales(rows.map((r) => r.yesterday));
        // The total is the sum of the normal days as listed, like one day of these locations together.
        const total = normalOf({
          gross: compared.reduce((sum, r) => sum.plus(r.normal.gross), new Decimal(0)),
          days: compared.length > 0 ? 1 : 0,
          yesterday: comparedGross,
        });
        const part = (sales: SalesSums, lastWeekSales: SalesSums, openTables: number) => ({
          ...salesFigures(sales),
          openTables,
          changePercent: changePercent(sales.gross, lastWeekSales.gross),
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
              addSales(rows.map((r) => r.today)),
              addSales(rows.map((r) => r.lastWeek)),
              rows.reduce((sum, r) => sum + r.openTables, 0),
            ),
            yesterday: {
              gross: METRIC['sales.gross']({ sales: all }),
              orders: METRIC['sales.orders']({ sales: all }),
              normal: total && { ...total, compared: comparedGross.toFixed(2) },
              leftOut: rows.length - compared.length,
            },
          },
          locations: rows.map((r) => ({
            locationId: r.locationId,
            name: r.name,
            today: part(r.today, r.lastWeek, r.openTables),
            yesterday: {
              day: r.day,
              gross: METRIC['sales.gross']({ sales: r.yesterday }),
              orders: METRIC['sales.orders']({ sales: r.yesterday }),
              normal: r.normal && { ...r.normal, days: r.days },
            },
          })),
        };
      },
      { archivedAt: null, isWarehouseSite: false },
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
      const rows = await this.facts.hours(spans(places, periodOf(query)), tx);
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
      const rows = await this.facts.products(spans(places, periodOf(query)), tx);
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
      const rows = await this.facts.products(spans(places, periodOf(query)), tx);
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
      const rows = await this.facts.tables(spans(places, periodOf(query)), tx);
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
      const { total, bands } = await this.facts.reservations(spans(places, periodOf(query)), tx);
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
    return addSales((await this.facts.sales(spans(places, span), tx)).values());
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
        const locations = await tx.location.findMany({
          where: {
            ...only,
            ...(scope === 'all' ? {} : { id: { in: scope } }),
            ...(query.locationId ? { AND: { id: query.locationId } } : {}),
          },
          select: { id: true, name: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        if (query.locationId && locations.length === 0) throw locationNotFound();
        const places: Place[] = [];
        for (const { id, name } of locations) {
          const at = { locationId: id };
          places.push({
            locationId: id,
            name,
            clock: {
              timeZone: await this.settings.get('timezone', at, tx),
              dayStartsAt: await this.settings.get('reports.dayStartsAt', at, tx),
            },
          });
        }
        return fn(places, tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

/** A normal day and how yesterday differs from it; null when no day counts. */
function normalOf(normal: NormalDaySums) {
  const gross = METRIC['sales.normalDay']({ normal });
  if (gross === null) return null;
  return {
    gross,
    difference: normal.yesterday.minus(gross).toFixed(2),
    changePercent: METRIC['sales.vsNormalDay']({ normal }),
  };
}

const periodOf =
  (query: ReportQuery) =>
  ({ clock }: Place): Span =>
    daysSpan(query.from, query.to, clock);

const spans = (places: readonly Place[], span: (place: Place) => Span): LocationSpan[] =>
  places.map((place) => ({
    locationId: place.locationId,
    timeZone: place.clock.timeZone,
    ...span(place),
  }));
