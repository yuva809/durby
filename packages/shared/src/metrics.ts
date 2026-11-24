import type { FeatureKey } from './features';
import type { PermissionKey } from './permissions';

/**
 * Metric registry (docs/modules/reports.md, ADR 0081): one definition per figure. Cards, tables and exports take the
 * label and unit from here, and the api has exactly one query per key (a test fails otherwise).
 */
export const METRIC_UNITS = ['money', 'count', 'percent', 'minutes'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

export interface MetricDefinition {
  label: string;
  /** What the figure counts, shown next to it. */
  description: string;
  unit: MetricUnit;
  /** Needed next to `reports`. */
  feature: FeatureKey;
  permission: PermissionKey;
}

const sales = (name: string, unit: MetricUnit): MetricDefinition => ({
  label: `reports.metrics.${name}.name`,
  description: `reports.metrics.${name}.description`,
  unit,
  feature: 'pos',
  permission: 'reports.sales.read',
});

const reservations = (name: string, unit: MetricUnit): MetricDefinition => ({
  ...sales(name, unit),
  feature: 'reservations',
  permission: 'reports.reservations.read',
});

export const METRICS = {
  'sales.gross': sales('salesGross', 'money'),
  'sales.items': sales('salesItems', 'count'),
  'sales.orders': sales('salesOrders', 'count'),
  'sales.averageOrder': sales('salesAverageOrder', 'money'),
  'sales.secondRoundRate': sales('salesSecondRoundRate', 'percent'),
  'sales.normalDay': sales('salesNormalDay', 'money'),
  'sales.vsNormalDay': sales('salesVsNormalDay', 'percent'),
  'tables.averageMinutes': sales('tablesAverageMinutes', 'minutes'),
  'tables.open': sales('tablesOpen', 'count'),
  'reservations.covers': reservations('reservationsCovers', 'count'),
  'reservations.noShowRate': reservations('reservationsNoShowRate', 'percent'),
  'reservations.turnMinutes': reservations('reservationsTurnMinutes', 'minutes'),
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRICS;

export const METRIC_KEYS = Object.keys(METRICS) as readonly MetricKey[];
