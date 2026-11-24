import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { type LocalDate, NORMAL_DAY_WEEKS } from '@durby/shared';
import type { TenantTransactionClient } from '../../platform/tenancy';
import { FactsReader, spansOf } from './facts-reader';
import { addSales, METRIC, NO_SALES, type NormalDaySums, type SalesSums } from './metrics';
import { normalDayOf, type Span } from './periods';
import type { Place } from './places';

/** A normal day, and how the day differs from it. */
export interface Normal {
  gross: string;
  difference: string;
  changePercent: string | null;
}

export interface PlaceDay {
  place: Place;
  day: LocalDate;
  sales: SalesSums;
  /** How many of the four weekdays had orders. */
  days: number;
  normal: Normal | null;
}

export interface DayFiguresResult {
  places: PlaceDay[];
  total: {
    sales: SalesSums;
    /** Over the locations that have a normal day; `compared` is their day. */
    normal: (Normal & { compared: string }) | null;
    leftOut: number;
  };
}

/** A past business day against its normal day (ADR 0082): the overview and the daily report (ADR 0083) share it. */
@Injectable()
export class DayFigures {
  constructor(private readonly facts: FactsReader) {}

  async of(
    places: readonly Place[],
    dayOf: (place: Place) => LocalDate,
    tx: TenantTransactionClient,
  ): Promise<DayFiguresResult> {
    const days = new Map(
      places.map((place) => [place.locationId, normalDayOf(dayOf(place), place.clock)]),
    );
    const at = (span: (place: Place) => Span) => this.facts.sales(spansOf(places, span), tx);
    const sales = await at((place) => days.get(place.locationId)!.yesterday);
    const before: Map<string, SalesSums>[] = [];
    for (let week = 0; week < NORMAL_DAY_WEEKS; week += 1) {
      before.push(await at((place) => days.get(place.locationId)!.before[week]!));
    }
    const rows = places.map((place): PlaceDay => {
      const of = (sums: Map<string, SalesSums>) => sums.get(place.locationId) ?? NO_SALES;
      // A day without orders says nothing about a normal one: closed, or not open yet.
      const counted = before.map(of).filter((day) => day.orders > 0);
      return {
        place,
        day: days.get(place.locationId)!.day,
        sales: of(sales),
        days: counted.length,
        normal: normalOf({
          gross: addSales(counted).gross,
          days: counted.length,
          yesterday: of(sales).gross,
        }),
      };
    });
    const compared = rows.flatMap((r) => (r.normal ? [{ normal: r.normal, sales: r.sales }] : []));
    const comparedGross = addSales(compared.map((r) => r.sales)).gross;
    // The total is the sum of the normal days as listed, like one day of these locations together.
    const normal = normalOf({
      gross: compared.reduce((sum, r) => sum.plus(r.normal.gross), new Decimal(0)),
      days: compared.length > 0 ? 1 : 0,
      yesterday: comparedGross,
    });
    return {
      places: rows,
      total: {
        sales: addSales(rows.map((r) => r.sales)),
        normal: normal && { ...normal, compared: comparedGross.toFixed(2) },
        leftOut: rows.length - compared.length,
      },
    };
  }
}

function normalOf(normal: NormalDaySums): Normal | null {
  const gross = METRIC['sales.normalDay']({ normal });
  if (gross === null) return null;
  return {
    gross,
    difference: normal.yesterday.minus(gross).toFixed(2),
    changePercent: METRIC['sales.vsNormalDay']({ normal }),
  };
}
