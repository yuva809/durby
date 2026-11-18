import { describe, expect, it } from 'vitest';
import {
  calendarMonthIn,
  formatNumber,
  isNumberSeriesKey,
  NUMBER_SERIES,
  NUMBER_SERIES_KEYS,
  NUMBER_SERIES_KEY_PATTERN,
  type NumberFormat,
  numberFormatProblems,
  numberingPeriod,
  numberSeriesLabelBase,
  numberSeriesRegistryProblems,
  type NumberSeriesDefinition,
} from './numbering';

const format = (overrides: Partial<NumberFormat> = {}): NumberFormat => ({
  prefix: 'INV',
  pattern: '{prefix}-{YYYY}-{seq:6}',
  resetPolicy: 'yearly',
  ...overrides,
});

describe('number series registry', () => {
  it('has no problems', () => {
    expect(numberSeriesRegistryProblems(NUMBER_SERIES)).toEqual([]);
  });

  it('has the phase 1 series, then the table service and reservations ones', () => {
    expect(NUMBER_SERIES_KEYS).toEqual([
      'inventory.goodsReceipt',
      'inventory.stockAdjustment',
      'inventory.stockTransfer',
      'inventory.stockConsumption',
      'inventory.stockProduction',
      'inventory.purchaseOrder',
      'inventory.goodsIssue',
      'inventory.goodsRestock',
      'inventory.vendorInvoice',
      'orders.stockRequest',
      'orders.stockTransfer',
      'orders.salesOrder',
      'billing.invoice',
      'pos.order',
      'pos.guestCheck',
      'reservations.booking',
    ]);
  });

  it('recognizes registered keys only', () => {
    expect(isNumberSeriesKey('billing.invoice')).toBe(true);
    expect(isNumberSeriesKey('billing.creditNote')).toBe(false);
    expect(isNumberSeriesKey('toString')).toBe(false);
  });

  it('derives label keys from the key', () => {
    expect(numberSeriesLabelBase('inventory.goodsReceipt')).toBe(
      'platform.numbering.series.inventoryGoodsReceipt',
    );
  });

  it('reports bad keys, labels, features and defaults', () => {
    const def = (key: string, overrides: Partial<NumberSeriesDefinition> = {}) => ({
      label: `${numberSeriesLabelBase(key)}.name`,
      description: `${numberSeriesLabelBase(key)}.description`,
      feature: 'billing' as const,
      prefix: 'X',
      pattern: '{prefix}{YYYY}{seq:4}',
      resetPolicy: 'yearly' as const,
      ...overrides,
    });
    expect(
      numberSeriesRegistryProblems({
        invoice: def('invoice'),
        'billing.wrongLabel': { ...def('billing.wrongLabel'), label: 'x.y' },
        'billing.noFeature': def('billing.noFeature', { feature: 'nope' as 'billing' }),
        'billing.noYear': def('billing.noYear', { pattern: '{prefix}{seq:4}' }),
      }),
    ).toEqual([
      `invoice: key must match ${NUMBER_SERIES_KEY_PATTERN}`,
      'billing.wrongLabel: labels must be platform.numbering.series.billingWrongLabel.name and platform.numbering.series.billingWrongLabel.description',
      'billing.noFeature: unknown feature nope',
      'billing.noYear: default year_required',
    ]);
  });
});

describe('numberFormatProblems', () => {
  it('accepts the registry default and other valid patterns', () => {
    expect(numberFormatProblems(format())).toEqual([]);
    expect(numberFormatProblems(format({ pattern: '{YY}{MM}/{seq:4}' }))).toEqual([]);
    expect(numberFormatProblems(format({ pattern: '{seq:1}', resetPolicy: 'never' }))).toEqual([]);
    expect(numberFormatProblems(format({ prefix: 'R.E_2/x-1' }))).toEqual([]);
  });

  it.each([
    ['{prefix}-{YYYY}-{seq:6}-{DD}', 'unknown_token'],
    ['{prefix}-{YYYY}-{SEQ:6}', 'unknown_token'],
    ['{prefix}-{YYYY}-{seq}', 'unknown_token'],
    ['{prefix}-{YYYY}-{seq:6', 'stray_brace'],
    ['{prefix}}-{YYYY}-{seq:6}', 'stray_brace'],
    ['{prefix} {YYYY}-{seq:6}', 'invalid_literal'],
    ['{prefix}#{YYYY}-{seq:6}', 'invalid_literal'],
    ['{prefix}-{YYYY}', 'seq_missing'],
    ['{seq:3}-{YYYY}-{seq:6}', 'seq_repeated'],
    ['{prefix}-{YYYY}-{seq:0}', 'seq_width'],
    ['{prefix}-{YYYY}-{seq:13}', 'seq_width'],
    ['{prefix}-{MM}-{seq:6}', 'year_required'],
    [`{YYYY}${'-'.repeat(60)}{seq:6}`, 'pattern_too_long'],
    ['{YYYY}{YYYY}{YYYY}{YYYY}{YYYY}-{seq:12}', 'number_too_long'],
  ])('%s → %s', (pattern, problem) => {
    expect(numberFormatProblems(format({ pattern }))).toContain(problem);
  });

  it('requires a year token for yearly only', () => {
    expect(numberFormatProblems(format({ pattern: '{prefix}-{seq:6}' }))).toEqual([
      'year_required',
    ]);
    expect(
      numberFormatProblems(format({ pattern: '{prefix}-{seq:6}', resetPolicy: 'never' })),
    ).toEqual([]);
  });

  it.each(['', 'A'.repeat(17), 'IN V', 'RE{', 'Ä'])('rejects prefix %j', (prefix) => {
    expect(numberFormatProblems(format({ prefix }))).toEqual(['prefix_invalid']);
  });
});

describe('formatNumber', () => {
  const values = { prefix: 'INV', year: 2026, month: 3, sequence: 42n };

  it('renders every token', () => {
    expect(formatNumber('{prefix}-{YYYY}-{seq:6}', values)).toBe('INV-2026-000042');
    expect(formatNumber('{YY}{MM}/{seq:2}', values)).toBe('2603/42');
    expect(formatNumber('{prefix}{YY}{seq:1}', { ...values, year: 2105 })).toBe('INV0542');
  });

  it('grows the sequence past its padding', () => {
    expect(formatNumber('{seq:3}', { ...values, sequence: 999n })).toBe('999');
    expect(formatNumber('{seq:3}', { ...values, sequence: 1000n })).toBe('1000');
    expect(formatNumber('{seq:3}', { ...values, sequence: 9223372036854775807n })).toBe(
      '9223372036854775807',
    );
  });

  it('refuses an invalid pattern', () => {
    expect(() => formatNumber('{nope}{seq:3}', values)).toThrow(/Invalid number pattern/);
  });
});

describe('periods in the organization time zone', () => {
  it('31 Dec 23:30 in Berlin is still 2026 (22:30 UTC)', () => {
    const at = new Date('2026-12-31T22:30:00Z');
    expect(calendarMonthIn(at, 'Europe/Berlin')).toEqual({ year: 2026, month: 12 });
  });

  it('31 Dec 23:30 UTC is already 2027 in Berlin', () => {
    const at = new Date('2026-12-31T23:30:00Z');
    expect(calendarMonthIn(at, 'UTC')).toEqual({ year: 2026, month: 12 });
    expect(calendarMonthIn(at, 'Europe/Berlin')).toEqual({ year: 2027, month: 1 });
  });

  it('1 Jan 01:00 UTC is still 2026 in New York', () => {
    const at = new Date('2027-01-01T01:00:00Z');
    expect(calendarMonthIn(at, 'America/New_York')).toEqual({ year: 2026, month: 12 });
  });

  it('maps the year to a counter period', () => {
    expect(numberingPeriod('yearly', 2027)).toBe('2027');
    expect(numberingPeriod('never', 2027)).toBe('all');
  });
});
