import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { TURN_TIME_BANDS } from '@durby/shared';
import type { TenantTransactionClient } from '../../platform/tenancy';
import { NO_SALES, type ReservationSums, type SalesSums } from './metrics';
import type { Span } from './periods';

/** One location's part of a question: its span, and its zone where hours matter. */
export interface LocationSpan extends Span {
  locationId: string;
  timeZone: string;
}

/** The spans as one parameter: `jsonb_to_recordset` gives them back as rows. */
const spanRows = (spans: readonly LocationSpan[]): string =>
  JSON.stringify(
    spans.map((s) => ({
      location_id: s.locationId,
      from_at: s.start.toISOString(),
      to_at: s.end.toISOString(),
      time_zone: s.timeZone,
    })),
  );

/**
 * Sums over the fact tables (docs/modules/reports.md, ADR 0081), each location over its own span. In the caller's
 * transaction and tenant (RLS). Money stays numeric and comes back as text.
 */
@Injectable()
export class FactsReader {
  /** Per location; a location without sales is listed with zeros. */
  async sales(
    spans: readonly LocationSpan[],
    tx: TenantTransactionClient,
  ): Promise<Map<string, SalesSums>> {
    const result = new Map<string, SalesSums>(spans.map((s) => [s.locationId, NO_SALES]));
    if (spans.length === 0) return result;
    const lines = await tx.$queryRaw<{ location_id: string; gross: string; items: number }[]>`
      SELECT f.location_id, sum(f.gross)::text AS gross, sum(f.quantity)::int AS items
      FROM jsonb_to_recordset(${spanRows(spans)}::jsonb)
        AS span(location_id uuid, from_at timestamptz, to_at timestamptz, time_zone text)
      JOIN report_line_facts f
        ON f.location_id = span.location_id AND f.sent_at >= span.from_at AND f.sent_at < span.to_at
      GROUP BY f.location_id`;
    const orders = await tx.$queryRaw<{ location_id: string; orders: number; second: number }[]>`
      SELECT f.location_id, count(*)::int AS orders, count(*) FILTER (WHERE f.rounds >= 2)::int AS second
      FROM jsonb_to_recordset(${spanRows(spans)}::jsonb)
        AS span(location_id uuid, from_at timestamptz, to_at timestamptz, time_zone text)
      JOIN report_order_facts f
        ON f.location_id = span.location_id AND f.first_sent_at >= span.from_at
       AND f.first_sent_at < span.to_at
      GROUP BY f.location_id`;
    for (const row of lines) {
      result.set(row.location_id, {
        ...NO_SALES,
        gross: new Decimal(row.gross),
        items: row.items,
      });
    }
    for (const row of orders) {
      const sums = result.get(row.location_id) ?? NO_SALES;
      result.set(row.location_id, { ...sums, orders: row.orders, secondRoundOrders: row.second });
    }
    return result;
  }

  /** By wall-clock hour of the location; hours without sales are left out. Orders by their first line. */
  async hours(
    spans: readonly LocationSpan[],
    tx: TenantTransactionClient,
  ): Promise<{ hour: number; gross: string; items: number; orders: number }[]> {
    if (spans.length === 0) return [];
    return tx.$queryRaw`
      SELECT hour, sum(gross)::numeric(14,2)::text AS gross, sum(items)::int AS items,
             sum(orders)::int AS orders
      FROM (
        SELECT extract(hour FROM f.sent_at AT TIME ZONE span.time_zone)::int AS hour,
               f.gross, f.quantity AS items, 0 AS orders
        FROM jsonb_to_recordset(${spanRows(spans)}::jsonb)
        AS span(location_id uuid, from_at timestamptz, to_at timestamptz, time_zone text)
        JOIN report_line_facts f
          ON f.location_id = span.location_id AND f.sent_at >= span.from_at AND f.sent_at < span.to_at
        UNION ALL
        SELECT extract(hour FROM f.first_sent_at AT TIME ZONE span.time_zone)::int, 0, 0, 1
        FROM jsonb_to_recordset(${spanRows(spans)}::jsonb)
        AS span(location_id uuid, from_at timestamptz, to_at timestamptz, time_zone text)
        JOIN report_order_facts f
          ON f.location_id = span.location_id AND f.first_sent_at >= span.from_at
         AND f.first_sent_at < span.to_at
      ) AS parts
      GROUP BY hour
      ORDER BY hour`;
  }

  /** By product, most sold first. */
  async products(
    spans: readonly LocationSpan[],
    tx: TenantTransactionClient,
  ): Promise<{ productId: string; quantity: number; gross: string }[]> {
    if (spans.length === 0) return [];
    return tx.$queryRaw`
      SELECT f.product_id AS "productId", sum(f.quantity)::int AS quantity, sum(f.gross)::text AS gross
      FROM jsonb_to_recordset(${spanRows(spans)}::jsonb)
        AS span(location_id uuid, from_at timestamptz, to_at timestamptz, time_zone text)
      JOIN report_line_facts f
        ON f.location_id = span.location_id AND f.sent_at >= span.from_at AND f.sent_at < span.to_at
      GROUP BY f.product_id
      ORDER BY sum(f.quantity) DESC, sum(f.gross) DESC, f.product_id`;
  }

  /** Orders closed in the span, by table, without those merged away. */
  async tables(
    spans: readonly LocationSpan[],
    tx: TenantTransactionClient,
  ): Promise<{ tableId: string; orders: number; seconds: number }[]> {
    if (spans.length === 0) return [];
    return tx.$queryRaw`
      SELECT f.table_id AS "tableId", count(*)::int AS orders,
             sum(extract(epoch FROM f.closed_at - f.opened_at))::float8 AS seconds
      FROM jsonb_to_recordset(${spanRows(spans)}::jsonb)
        AS span(location_id uuid, from_at timestamptz, to_at timestamptz, time_zone text)
      JOIN report_order_facts f
        ON f.location_id = span.location_id AND f.closed_at >= span.from_at AND f.closed_at < span.to_at
       AND NOT f.merged_away
      GROUP BY f.table_id`;
  }

  /** Bookings starting in the span: the whole, and turn times by party size. */
  async reservations(
    spans: readonly LocationSpan[],
    tx: TenantTransactionClient,
  ): Promise<{ total: ReservationSums; bands: { bookings: number; seconds: number }[] }> {
    const rows =
      spans.length === 0
        ? []
        : await tx.$queryRaw<
            {
              party_size: number;
              walk_in: boolean;
              status: string;
              bookings: number;
              turns: number;
              seconds: number;
            }[]
          >`
      SELECT f.party_size, f.source = 'walk_in' AS walk_in, f.status::text AS status,
             count(*)::int AS bookings,
             count(*) FILTER (
               WHERE f.status = 'finished' AND f.seated_at IS NOT NULL AND f.finished_at >= f.seated_at
             )::int AS turns,
             coalesce(sum(extract(epoch FROM f.finished_at - f.seated_at)) FILTER (
               WHERE f.status = 'finished' AND f.seated_at IS NOT NULL AND f.finished_at >= f.seated_at
             ), 0)::float8 AS seconds
      FROM jsonb_to_recordset(${spanRows(spans)}::jsonb)
        AS span(location_id uuid, from_at timestamptz, to_at timestamptz, time_zone text)
      JOIN report_reservation_facts f
        ON f.location_id = span.location_id AND f.starts_at >= span.from_at AND f.starts_at < span.to_at
      WHERE f.status IN ('seated', 'finished', 'no_show')
      GROUP BY f.party_size, f.source, f.status`;
    const total: ReservationSums = {
      covers: 0,
      walkInCovers: 0,
      kept: 0,
      noShows: 0,
      turns: 0,
      turnSeconds: 0,
    };
    const bands = TURN_TIME_BANDS.map(() => ({ bookings: 0, seconds: 0 }));
    for (const row of rows) {
      if (row.status === 'no_show') {
        if (!row.walk_in) total.noShows += row.bookings;
        continue;
      }
      const covers = row.party_size * row.bookings;
      total.covers += covers;
      if (row.walk_in) total.walkInCovers += covers;
      else total.kept += row.bookings;
      total.turns += row.turns;
      total.turnSeconds += row.seconds;
      const band = TURN_TIME_BANDS.findIndex(
        (b) => row.party_size >= b.min && (b.max === null || row.party_size <= b.max),
      );
      if (bands[band]) {
        bands[band].bookings += row.turns;
        bands[band].seconds += row.seconds;
      }
    }
    return { total, bands };
  }
}
