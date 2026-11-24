import {
  reservationsReportResponseSchema,
  salesCategoriesResponseSchema,
  salesHoursResponseSchema,
  salesItemsResponseSchema,
  salesSummaryResponseSchema,
  tablesReportResponseSchema,
} from '@durby/shared';
import { type Api, read } from '../api-call';

/** Calls of the report pages (docs/modules/reports.md → Routes), parsed with the shared schemas. */

export interface ReportFilter {
  from: string;
  to: string;
  locationId: string | null;
}

const BASE = '/api/v1/reports';

export function reportQuery({ from, to, locationId }: ReportFilter): string {
  const search = new URLSearchParams({ from, to });
  if (locationId) search.set('locationId', locationId);
  return `?${search.toString()}`;
}

export const loadSummary = (store: Api, filter: ReportFilter) =>
  read(store, `${BASE}/sales/summary${reportQuery(filter)}`, salesSummaryResponseSchema);

export const loadHours = (store: Api, filter: ReportFilter) =>
  read(store, `${BASE}/sales/hours${reportQuery(filter)}`, salesHoursResponseSchema);

export const loadItems = (store: Api, filter: ReportFilter) =>
  read(store, `${BASE}/sales/items${reportQuery(filter)}`, salesItemsResponseSchema);

export const loadCategories = (store: Api, filter: ReportFilter) =>
  read(store, `${BASE}/sales/categories${reportQuery(filter)}`, salesCategoriesResponseSchema);

export const loadTables = (store: Api, filter: ReportFilter) =>
  read(store, `${BASE}/tables${reportQuery(filter)}`, tablesReportResponseSchema);

export const loadReservations = (store: Api, filter: ReportFilter) =>
  read(store, `${BASE}/reservations${reportQuery(filter)}`, reservationsReportResponseSchema);
