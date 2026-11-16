import { type FeatureKey, isFeatureKey } from './features';
import { zonedParts } from './time/zoned';

/**
 * Number series registry (`module.camelCaseName`). See docs/platform/numbering.md and ADR 0012.
 *
 * Adding a key: a name and a description label (`en` and `de` defaults in packages/i18n), the
 * feature whose module issues the numbers, and a default prefix, pattern and reset policy that pass
 * the rules below. No migration: an organization's series is created on first use. A test fails on
 * bad keys, labels, unknown features or defaults that break the rules.
 */

export const NUMBER_RESET_POLICIES = ['yearly', 'never'] as const;

export type NumberResetPolicy = (typeof NUMBER_RESET_POLICIES)[number];

export interface NumberSeriesDefinition {
  /** Label key of the series' display name. */
  label: string;
  /** Label key of a one-line description. */
  description: string;
  /** The feature of the module that issues these numbers. */
  feature: FeatureKey;
  /** Defaults copied into an organization's series when it is created. */
  prefix: string;
  pattern: string;
  resetPolicy: NumberResetPolicy;
}

export const NUMBER_SERIES = {
  'inventory.goodsReceipt': {
    label: 'platform.numbering.series.inventoryGoodsReceipt.name',
    description: 'platform.numbering.series.inventoryGoodsReceipt.description',
    feature: 'inventory',
    prefix: 'GR',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  // Stock documents (docs/modules/inventory.md): receipts use inventory.goodsReceipt.
  'inventory.stockAdjustment': {
    label: 'platform.numbering.series.inventoryStockAdjustment.name',
    description: 'platform.numbering.series.inventoryStockAdjustment.description',
    feature: 'inventory',
    prefix: 'ADJ',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  'inventory.stockTransfer': {
    label: 'platform.numbering.series.inventoryStockTransfer.name',
    description: 'platform.numbering.series.inventoryStockTransfer.description',
    feature: 'inventory',
    prefix: 'TRF',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  /** Stock taken by table-service sales (docs/modules/inventory.md → Consumption). */
  'inventory.stockConsumption': {
    label: 'platform.numbering.series.inventoryStockConsumption.name',
    description: 'platform.numbering.series.inventoryStockConsumption.description',
    feature: 'inventory',
    prefix: 'CON',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  /** Production orders: ingredients out, the prepared item in (ADR 0038). */
  'inventory.stockProduction': {
    label: 'platform.numbering.series.inventoryStockProduction.name',
    description: 'platform.numbering.series.inventoryStockProduction.description',
    feature: 'inventory',
    prefix: 'PRD',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  'inventory.purchaseOrder': {
    label: 'platform.numbering.series.inventoryPurchaseOrder.name',
    description: 'platform.numbering.series.inventoryPurchaseOrder.description',
    feature: 'inventory.purchasing',
    prefix: 'PO',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  /** Sales orders of a distribution business (ADR 0044). */
  'orders.salesOrder': {
    label: 'platform.numbering.series.ordersSalesOrder.name',
    description: 'platform.numbering.series.ordersSalesOrder.description',
    feature: 'orders',
    prefix: 'SO',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  'billing.invoice': {
    label: 'platform.numbering.series.billingInvoice.name',
    description: 'platform.numbering.series.billingInvoice.description',
    feature: 'billing',
    prefix: 'INV',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  /** Table service orders (docs/modules/pos.md → Step 3). */
  'pos.order': {
    label: 'platform.numbering.series.posOrder.name',
    description: 'platform.numbering.series.posOrder.description',
    feature: 'pos',
    prefix: 'ORD',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  /** Guest checks, printed from a bill (docs/modules/pos.md → Step 4, ADR 0036). */
  'pos.guestCheck': {
    label: 'platform.numbering.series.posGuestCheck.name',
    description: 'platform.numbering.series.posGuestCheck.description',
    feature: 'pos',
    prefix: 'CHK',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
  // docs/modules/reservations.md → Number series: the guest-facing booking reference.
  'reservations.booking': {
    label: 'platform.numbering.series.reservationsBooking.name',
    description: 'platform.numbering.series.reservationsBooking.description',
    feature: 'reservations',
    prefix: 'RES',
    pattern: '{prefix}-{YYYY}-{seq:6}',
    resetPolicy: 'yearly',
  },
} as const satisfies Record<string, NumberSeriesDefinition>;

export type NumberSeriesKey = keyof typeof NUMBER_SERIES;

/** Registry order: used for every list of series the api returns. */
export const NUMBER_SERIES_KEYS = Object.keys(NUMBER_SERIES) as readonly NumberSeriesKey[];

/** Same shape as `number_series_key_format_check`: a module and a camelCase name. */
export const NUMBER_SERIES_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Same as `number_series_prefix_check`. */
export const NUMBER_PREFIX_PATTERN = /^[A-Za-z0-9._/-]{1,16}$/;

export const MAX_PATTERN_LENGTH = 64;
/** Rendered with the sequence at its padded width. */
export const MAX_NUMBER_LENGTH = 32;
export const MAX_SEQ_WIDTH = 12;

/** The `period` of a counter that never resets. */
export const ALL_PERIODS = 'all';

/** Problems of a prefix or pattern. Labels: `platform.numbering.problems.<camelCaseCode>`. */
export const NUMBER_PATTERN_PROBLEMS = [
  'prefix_invalid',
  'pattern_too_long',
  'unknown_token',
  'stray_brace',
  'invalid_literal',
  'seq_missing',
  'seq_repeated',
  'seq_width',
  'number_too_long',
  'year_required',
] as const;

export type NumberPatternProblem = (typeof NUMBER_PATTERN_PROBLEMS)[number];

export function isNumberSeriesKey(value: string): value is NumberSeriesKey {
  return Object.prototype.hasOwnProperty.call(NUMBER_SERIES, value);
}

/** `billing.invoice` → `platform.numbering.series.billingInvoice`. */
export function numberSeriesLabelBase(key: string): string {
  return `platform.numbering.series.${key.replace(/\.([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

/** `seq_missing` → `platform.numbering.problems.seqMissing`. */
export function numberPatternProblemLabel(problem: NumberPatternProblem): string {
  return `platform.numbering.problems.${problem.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

export type PatternPart =
  | { type: 'literal'; text: string }
  | { type: 'prefix' }
  | { type: 'year4' }
  | { type: 'year2' }
  | { type: 'month' }
  | { type: 'seq'; width: number };

const LITERAL = /^[A-Za-z0-9._/-]+$/;
const FIXED_TOKENS: Readonly<Record<string, PatternPart>> = {
  prefix: { type: 'prefix' },
  YYYY: { type: 'year4' },
  YY: { type: 'year2' },
  MM: { type: 'month' },
};

/** Splits a pattern into parts; problems are the token-level ones (no length or policy rules). */
export function parsePattern(pattern: string): {
  parts: PatternPart[];
  problems: Set<NumberPatternProblem>;
} {
  const parts: PatternPart[] = [];
  const problems = new Set<NumberPatternProblem>();
  const literal = (text: string) => {
    if (text === '') return;
    if (text.includes('{') || text.includes('}')) problems.add('stray_brace');
    else if (!LITERAL.test(text)) problems.add('invalid_literal');
    else parts.push({ type: 'literal', text });
  };
  const token = /\{([^{}]*)\}/g;
  let last = 0;
  for (let match = token.exec(pattern); match; match = token.exec(pattern)) {
    literal(pattern.slice(last, match.index));
    last = match.index + match[0].length;
    const name = match[1] ?? '';
    const fixed = FIXED_TOKENS[name];
    const seq = /^seq:([0-9]{1,2})$/.exec(name);
    if (fixed) parts.push(fixed);
    else if (seq) {
      const width = Number(seq[1]);
      if (width < 1 || width > MAX_SEQ_WIDTH) problems.add('seq_width');
      parts.push({ type: 'seq', width });
    } else problems.add('unknown_token');
  }
  literal(pattern.slice(last));
  return { parts, problems };
}

export interface NumberFormat {
  prefix: string;
  pattern: string;
  resetPolicy: NumberResetPolicy;
}

/** Every rule of docs/platform/numbering.md → Patterns, in NUMBER_PATTERN_PROBLEMS order. */
export function numberFormatProblems(format: NumberFormat): NumberPatternProblem[] {
  const problems = new Set<NumberPatternProblem>();
  if (!NUMBER_PREFIX_PATTERN.test(format.prefix)) problems.add('prefix_invalid');
  if (format.pattern.length > MAX_PATTERN_LENGTH) problems.add('pattern_too_long');
  const parsed = parsePattern(format.pattern);
  for (const problem of parsed.problems) problems.add(problem);
  const seqs = parsed.parts.filter((p) => p.type === 'seq').length;
  if (seqs === 0) problems.add('seq_missing');
  if (seqs > 1) problems.add('seq_repeated');
  if (
    format.resetPolicy === 'yearly' &&
    !parsed.parts.some((p) => p.type === 'year4' || p.type === 'year2')
  ) {
    problems.add('year_required');
  }
  if (problems.size === 0) {
    const sample = renderParts(parsed.parts, {
      prefix: format.prefix,
      year: 2026,
      month: 12,
      sequence: 1n,
    });
    if (sample.length > MAX_NUMBER_LENGTH) problems.add('number_too_long');
  }
  return NUMBER_PATTERN_PROBLEMS.filter((p) => problems.has(p));
}

export interface NumberValues {
  prefix: string;
  /** Calendar year and month (1–12) of the allocation in the organization's time zone. */
  year: number;
  month: number;
  sequence: bigint;
}

/** Renders a valid pattern; the sequence grows past its padding. */
export function formatNumber(pattern: string, values: NumberValues): string {
  const { parts, problems } = parsePattern(pattern);
  if (problems.size > 0) throw new Error(`Invalid number pattern: ${pattern}`);
  return renderParts(parts, values);
}

function renderParts(parts: readonly PatternPart[], values: NumberValues): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case 'literal':
          return part.text;
        case 'prefix':
          return values.prefix;
        case 'year4':
          return String(values.year).padStart(4, '0');
        case 'year2':
          return String(values.year % 100).padStart(2, '0');
        case 'month':
          return String(values.month).padStart(2, '0');
        case 'seq':
          return values.sequence.toString().padStart(part.width, '0');
      }
    })
    .join('');
}

/** Calendar year and month of `at` in `timeZone` (an IANA name, e.g. the `timezone` setting). */
export function calendarMonthIn(at: Date, timeZone: string): { year: number; month: number } {
  const { year, month } = zonedParts(at, timeZone);
  return { year, month };
}

/** The counter period: the calendar year for `yearly`, `all` for `never`. */
export function numberingPeriod(policy: NumberResetPolicy, year: number): string {
  return policy === 'yearly' ? String(year) : ALL_PERIODS;
}

/** Same as `number_series_counters_period_check`. */
export const NUMBER_PERIOD_PATTERN = /^(all|[0-9]{4})$/;

/**
 * Problems of a number series registry: bad key shape, labels not derived from the key, an
 * unregistered feature, defaults that break the rules. Empty for NUMBER_SERIES (tested).
 */
export function numberSeriesRegistryProblems(
  registry: Readonly<Record<string, NumberSeriesDefinition>>,
): string[] {
  const problems: string[] = [];
  for (const [key, def] of Object.entries(registry)) {
    if (!NUMBER_SERIES_KEY_PATTERN.test(key)) {
      problems.push(`${key}: key must match ${NUMBER_SERIES_KEY_PATTERN}`);
    }
    const base = numberSeriesLabelBase(key);
    if (def.label !== `${base}.name` || def.description !== `${base}.description`) {
      problems.push(`${key}: labels must be ${base}.name and ${base}.description`);
    }
    const feature: string = def.feature;
    if (!isFeatureKey(feature)) problems.push(`${key}: unknown feature ${feature}`);
    for (const problem of numberFormatProblems(def)) {
      problems.push(`${key}: default ${problem}`);
    }
  }
  return problems;
}
