import { z } from 'zod';
import { addDays, isLocalDate } from '../time/zoned';

/** Queries and responses of `/reports` (docs/modules/reports.md, ADR 0081). Money: gross, two decimals. */

/** Longest period of one report, in days. */
export const REPORT_MAX_DAYS = 366;

const localDate = z.string().refine(isLocalDate);
const money = z.string();

/** Business days `from`–`to`, both included; without `locationId`, every location the caller may read. */
export const reportQuerySchema = z
  .strictObject({ from: localDate, to: localDate, locationId: z.uuid().optional() })
  .refine(
    // A refinement also runs when a date is invalid; addDays throws on those.
    (q) =>
      isLocalDate(q.from) &&
      isLocalDate(q.to) &&
      q.from <= q.to &&
      q.to < addDays(q.from, REPORT_MAX_DAYS),
    { path: ['to'] },
  );

export const salesFiguresSchema = z.object({
  gross: money,
  items: z.int(),
  orders: z.int(),
  /** Null without orders. */
  averageOrder: money.nullable(),
});

export const SALES_CARDS = ['today', 'yesterday', 'week'] as const;

export const salesCardSchema = z.object({
  key: z.enum(SALES_CARDS),
  figures: salesFiguresSchema,
  /** The same weekday (or span of the week) a week earlier; today and this week up to the same time. */
  compare: salesFiguresSchema,
  /** Change of `gross` in percent, one decimal; null when the comparison has no sales. */
  changePercent: z.string().nullable(),
});

export const salesSummaryResponseSchema = z.object({
  currency: z.string(),
  cards: z.array(salesCardSchema),
  period: salesFiguresSchema.extend({
    /** Orders with two or more rounds, and their share in percent (one decimal, null without orders). */
    secondRoundOrders: z.int(),
    secondRoundRate: z.string().nullable(),
  }),
});

export const salesHoursResponseSchema = z.object({
  currency: z.string(),
  /** All 24 wall-clock hours. */
  data: z.array(z.object({ hour: z.int(), gross: money, items: z.int(), orders: z.int() })),
});

export const salesItemsResponseSchema = z.object({
  currency: z.string(),
  /** Products sold at least once in the period, most sold first. */
  data: z.array(
    z.object({
      productId: z.uuid(),
      name: z.string(),
      categoryName: z.string(),
      quantity: z.int(),
      gross: money,
    }),
  ),
});

export const salesCategoriesResponseSchema = z.object({
  currency: z.string(),
  data: z.array(
    z.object({
      categoryId: z.uuid(),
      name: z.string(),
      quantity: z.int(),
      gross: money,
      /** Percent of the period's gross, one decimal; null when that is zero. */
      share: z.string().nullable(),
    }),
  ),
});

export const tablesReportResponseSchema = z.object({
  /** Closed orders in the period, without those merged away. */
  orders: z.int(),
  averageMinutes: z.int().nullable(),
  tables: z.array(
    z.object({
      tableId: z.uuid(),
      locationId: z.uuid(),
      name: z.string(),
      orders: z.int(),
      averageMinutes: z.int(),
    }),
  ),
  /** Open now, whatever the period. */
  open: z.array(
    z.object({
      tableId: z.uuid(),
      locationId: z.uuid(),
      name: z.string(),
      openedAt: z.iso.datetime(),
      covers: z.int().nullable(),
    }),
  ),
});

/** Party sizes turn times are grouped by; `max` null = and more. */
export const TURN_TIME_BANDS = [
  { min: 1, max: 2 },
  { min: 3, max: 4 },
  { min: 5, max: 6 },
  { min: 7, max: null },
] as const;

export const reservationsReportResponseSchema = z.object({
  /** Guests of seated and finished bookings, walk-ins included. */
  covers: z.int(),
  walkInCovers: z.int(),
  /** Seated and finished bookings without walk-ins. */
  kept: z.int(),
  noShows: z.int(),
  noShowRate: z.string().nullable(),
  turnMinutes: z.int().nullable(),
  turnTimes: z.array(
    z.object({
      min: z.int(),
      max: z.int().nullable(),
      bookings: z.int(),
      minutes: z.int().nullable(),
    }),
  ),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type SalesFigures = z.infer<typeof salesFiguresSchema>;
export type SalesCard = z.infer<typeof salesCardSchema>;
export type SalesSummaryResponse = z.infer<typeof salesSummaryResponseSchema>;
export type SalesHoursResponse = z.infer<typeof salesHoursResponseSchema>;
export type SalesItemsResponse = z.infer<typeof salesItemsResponseSchema>;
export type SalesCategoriesResponse = z.infer<typeof salesCategoriesResponseSchema>;
export type TablesReportResponse = z.infer<typeof tablesReportResponseSchema>;
export type ReservationsReportResponse = z.infer<typeof reservationsReportResponseSchema>;

export const REPORTS_ERROR_CODES = ['reports.location_not_found'] as const;
export type ReportsErrorCode = (typeof REPORTS_ERROR_CODES)[number];
