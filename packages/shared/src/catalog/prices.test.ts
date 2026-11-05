import { describe, expect, it } from 'vitest';
import { priceRuleProblems } from '../api/price-rules';
import { cents, coversMoment, type PricedRule, resolvePrice } from './prices';

const MAIN = 'loc-main';
const HARBOUR = 'loc-harbour';
const COLA = { id: 'cola', categoryId: 'drinks', price: '3.80' };
const SOUP = { id: 'soup', categoryId: 'food', price: '6.90' };

let n = 0;
const rule = (over: Partial<PricedRule>): PricedRule => ({
  id: `r${String(++n).padStart(3, '0')}`,
  name: 'Rule',
  locationId: null,
  productId: null,
  categoryId: null,
  kind: 'fixed',
  value: '0.00',
  days: [],
  startsAt: null,
  endsAt: null,
  validFrom: null,
  validUntil: null,
  active: true,
  ...over,
});
// 2026-11-06 is a Friday.
const at = (time: string, date = '2026-11-06', locationId = MAIN) => ({ locationId, date, time });
const price = (rules: PricedRule[], moment = at('12:00'), product = COLA) =>
  resolvePrice(product, rules, moment).price;

describe('resolvePrice (ADR 0030)', () => {
  it("is the product's own price without rules", () => {
    expect(resolvePrice(COLA, [], at('12:00'))).toEqual({
      price: '3.80',
      ruleId: null,
      ruleName: null,
      timed: false,
    });
  });

  it('takes the most specific regular rule: product here > product everywhere > category here > everywhere', () => {
    const all = rule({ categoryId: 'drinks', value: '3.00' });
    const catHere = rule({ categoryId: 'drinks', locationId: MAIN, value: '3.10' });
    const prodAll = rule({ productId: 'cola', value: '3.20' });
    const prodHere = rule({ productId: 'cola', locationId: MAIN, value: '3.30' });
    expect(price([all])).toBe('3.00');
    expect(price([all, catHere])).toBe('3.10');
    expect(price([all, catHere, prodAll])).toBe('3.20');
    expect(price([all, catHere, prodAll, prodHere])).toBe('3.30');
    // Another location's rules never apply; a category rule only to its own products.
    expect(price([prodHere], at('12:00', '2026-11-06', HARBOUR))).toBe('3.80');
    expect(price([catHere], at('12:00'), SOUP)).toBe('6.90');
  });

  it('applies a happy hour on top of the location price, only within its hours and days', () => {
    const here = rule({ productId: 'cola', locationId: MAIN, value: '4.00' });
    const happy = rule({
      name: 'Happy hour',
      categoryId: 'drinks',
      kind: 'percent_off',
      value: '25',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      startsAt: '17:00',
      endsAt: '19:00',
    });
    expect(resolvePrice(COLA, [here, happy], at('18:00'))).toEqual({
      price: '3.00',
      ruleId: happy.id,
      ruleName: 'Happy hour',
      timed: true,
    });
    expect(price([here, happy], at('19:00'))).toBe('4.00');
    expect(price([here, happy], at('16:59'))).toBe('4.00');
    // Saturday.
    expect(price([here, happy], at('18:00', '2026-11-07'))).toBe('4.00');
    // Without time rules (margins): the regular price.
    expect(resolvePrice(COLA, [here, happy], at('18:00'), { timed: false }).price).toBe('4.00');
  });

  it('rounds a percentage half up to the cent', () => {
    // 3.85 less 10 % = 3.465 → 3.47
    expect(
      price(
        [rule({ categoryId: 'drinks', kind: 'percent_off', value: '10', days: ['fri'] })],
        at('12:00'),
        { ...COLA, price: '3.85' },
      ),
    ).toBe('3.47');
    expect(cents('12.5')).toBe(1250n);
    expect(cents('7')).toBe(700n);
  });

  it('runs hours past midnight on the day they start', () => {
    const late = rule({
      productId: 'cola',
      value: '2.50',
      days: ['fri'],
      startsAt: '22:00',
      endsAt: '02:00',
    });
    expect(price([late], at('23:30'))).toBe('2.50');
    expect(price([late], at('01:00', '2026-11-07'))).toBe('2.50');
    expect(price([late], at('02:00', '2026-11-07'))).toBe('3.80');
    // Thursday night into Friday: not Friday's rule.
    expect(price([late], at('01:00', '2026-11-06'))).toBe('3.80');
    expect(coversMoment(late, '2026-11-06', '21:59')).toBe(false);
  });

  it('keeps to its dates, and inactive rules never apply', () => {
    const promo = rule({
      productId: 'cola',
      value: '2.00',
      validFrom: '2026-11-01',
      validUntil: '2026-11-06',
    });
    expect(price([promo], at('12:00', '2026-11-06'))).toBe('2.00');
    expect(price([promo], at('12:00', '2026-11-07'))).toBe('3.80');
    expect(price([promo], at('12:00', '2026-10-31'))).toBe('3.80');
    expect(price([{ ...promo, active: false }], at('12:00', '2026-11-06'))).toBe('3.80');
  });

  it('gives the lower price when equally specific rules overlap, whatever their order', () => {
    const a = rule({ categoryId: 'drinks', kind: 'percent_off', value: '10', days: ['fri'] });
    const b = rule({ categoryId: 'drinks', kind: 'percent_off', value: '20', days: ['fri'] });
    expect(price([a, b])).toBe('3.04');
    expect(price([b, a])).toBe('3.04');
  });

  it('lets a product time rule beat a category time rule', () => {
    const cat = rule({ categoryId: 'drinks', kind: 'percent_off', value: '50', days: ['fri'] });
    const prod = rule({ productId: 'cola', value: '3.50', days: ['fri'] });
    expect(price([cat, prod])).toBe('3.50');
  });
});

describe('priceRuleProblems', () => {
  const base = {
    productId: null,
    categoryId: 'drinks',
    kind: 'fixed' as const,
    value: '3.00',
    startsAt: null,
    endsAt: null,
    validFrom: null,
    validUntil: null,
  };
  it('accepts a valid rule and names every problem', () => {
    expect(priceRuleProblems(base)).toEqual([]);
    expect(priceRuleProblems({ ...base, categoryId: null })).toEqual(['target']);
    expect(priceRuleProblems({ ...base, productId: 'cola' })).toEqual(['target']);
    expect(
      priceRuleProblems({
        ...base,
        productId: 'cola',
        categoryId: null,
        kind: 'percent_off',
        value: '10',
      }),
    ).toEqual(['percent_on_product']);
    expect(priceRuleProblems({ ...base, kind: 'percent_off', value: '0' })).toEqual(['value']);
    expect(priceRuleProblems({ ...base, kind: 'percent_off', value: '100.5' })).toEqual(['value']);
    expect(priceRuleProblems({ ...base, value: '-1' })).toEqual(['value']);
    expect(priceRuleProblems({ ...base, startsAt: '17:00' })).toEqual(['hours']);
    expect(priceRuleProblems({ ...base, startsAt: '17:00', endsAt: '17:00' })).toEqual(['hours']);
    expect(
      priceRuleProblems({ ...base, validFrom: '2026-12-01', validUntil: '2026-11-01' }),
    ).toEqual(['dates']);
  });
});
