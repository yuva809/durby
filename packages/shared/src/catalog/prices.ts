import type { PriceRule } from '../api/price-rules';
import { addDays, type LocalDate, type LocalTime, weekdayOf } from '../time/zoned';

/**
 * Which price a product has at a location at one moment (docs/modules/catalog.md → Price rules,
 * ADR 0030). Pure and shared: the api charges it, the web shows it.
 *
 * 1. The regular price: the most specific matching rule without days, hours or dates, else the
 *    product's own price.
 * 2. A time rule (days, hours or dates) matching now, most specific first, applies to the regular
 *    price: `fixed` replaces it, `percent_off` takes a share off.
 * Specificity: product at this location > product everywhere > category at this location > category
 * everywhere. Equally specific rules: the lower price wins (then the smaller id, for a stable answer).
 *
 * Money in whole cents as BigInt, never JS numbers (CLAUDE.md rule 6).
 */

export type PricedRule = Pick<
  PriceRule,
  | 'id'
  | 'name'
  | 'locationId'
  | 'productId'
  | 'categoryId'
  | 'kind'
  | 'value'
  | 'days'
  | 'startsAt'
  | 'endsAt'
  | 'validFrom'
  | 'validUntil'
  | 'active'
>;

export interface PricedProduct {
  id: string;
  categoryId: string;
  /** Decimal text. */
  price: string;
}

/** The location and its wall clock (its `timezone` setting). */
export interface PriceMoment {
  locationId: string;
  date: LocalDate;
  time: LocalTime;
}

export interface ResolvedPrice {
  /** 2 decimals. */
  price: string;
  ruleId: string | null;
  ruleName: string | null;
  timed: boolean;
}

/** Days, hours or dates: the rule applies only at some times. */
export function isTimed(rule: PricedRule): boolean {
  return (
    rule.days.length > 0 ||
    rule.startsAt !== null ||
    rule.validFrom !== null ||
    rule.validUntil !== null
  );
}

const dayOk = (rule: PricedRule, date: LocalDate) =>
  (rule.days.length === 0 || rule.days.includes(weekdayOf(date))) &&
  (rule.validFrom === null || date >= rule.validFrom) &&
  (rule.validUntil === null || date <= rule.validUntil);

/**
 * Whether a rule's days, hours and dates cover `date` `time`. Hours past midnight (22:00–02:00) belong
 * to the day they start: Friday's 22:00–02:00 covers Saturday 01:00.
 */
export function coversMoment(rule: PricedRule, date: LocalDate, time: LocalTime): boolean {
  const { startsAt, endsAt } = rule;
  if (startsAt === null || endsAt === null) return dayOk(rule, date);
  if (startsAt < endsAt) return time >= startsAt && time < endsAt && dayOk(rule, date);
  // Past midnight: the evening part today, or the early part of the day after the start day.
  return (
    (time >= startsAt && dayOk(rule, date)) || (time < endsAt && dayOk(rule, addDays(date, -1)))
  );
}

/** 0 is the most specific. */
function rank(rule: PricedRule): number {
  return (rule.productId !== null ? 0 : 2) + (rule.locationId !== null ? 0 : 1);
}

function applies(rule: PricedRule, product: PricedProduct, at: PriceMoment): boolean {
  return (
    rule.active &&
    (rule.locationId === null || rule.locationId === at.locationId) &&
    (rule.productId === product.id ||
      (rule.productId === null && rule.categoryId === product.categoryId))
  );
}

/** The best of the most specific rules, with its price applied to `base`. */
function pick(rules: PricedRule[], base: bigint): { rule: PricedRule; cents: bigint } | null {
  if (rules.length === 0) return null;
  const best = Math.min(...rules.map(rank));
  return rules
    .filter((r) => rank(r) === best)
    .map((rule) => ({ rule, cents: priceAfter(rule, base) }))
    .sort((a, b) =>
      a.cents === b.cents ? (a.rule.id < b.rule.id ? -1 : 1) : a.cents < b.cents ? -1 : 1,
    )[0]!;
}

export function resolvePrice(
  product: PricedProduct,
  rules: readonly PricedRule[],
  at: PriceMoment,
  options: { timed?: boolean } = {},
): ResolvedPrice {
  const own = cents(product.price);
  const matching = rules.filter((r) => applies(r, product, at));
  const regular = pick(
    matching.filter((r) => !isTimed(r)),
    own,
  );
  const base = regular?.cents ?? own;
  const timed =
    options.timed === false
      ? null
      : pick(
          matching.filter((r) => isTimed(r) && coversMoment(r, at.date, at.time)),
          base,
        );
  const decided = timed ?? regular;
  return {
    price: text(decided?.cents ?? own),
    ruleId: decided?.rule.id ?? null,
    ruleName: decided?.rule.name ?? null,
    timed: timed !== null,
  };
}

/** A rule's price on top of `base`: a fixed price, or the base less a percentage (half up). */
function priceAfter(rule: PricedRule, base: bigint): bigint {
  if (rule.kind === 'fixed') return cents(rule.value);
  const keep = 10_000n - cents(rule.value); // basis points
  return (base * keep + 5_000n) / 10_000n;
}

/** `"12.5"` → 1250n. Two decimals at most (the schemas check that). */
export function cents(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

function text(value: bigint): string {
  const whole = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}
