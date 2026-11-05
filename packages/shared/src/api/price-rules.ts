import { z } from 'zod';
import { isLocalDate, isLocalTime, WEEKDAYS } from '../time/zoned';
import { priceSchema } from './catalog';

/**
 * Price rules (docs/modules/catalog.md → Price rules, ADR 0030): a product's price at a location, or a
 * happy hour on a category, on given weekdays, hours and dates. Money is decimal text (rule 6).
 */

export const PRICE_RULE_KINDS = ['fixed', 'percent_off'] as const;
export type PriceRuleKind = (typeof PRICE_RULE_KINDS)[number];
export const PRICE_RULE_NAME_MAX_LENGTH = 60;

/** A percentage in (0, 100] with up to 2 decimals. */
export const percentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Invalid percentage')
  .refine((v) => Number(v) > 0 && Number(v) <= 100, 'Invalid percentage');

const localTime = z.string().refine(isLocalTime, 'Invalid time');
const localDate = z.string().refine(isLocalDate, 'Invalid date');

export const priceRuleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** null: every location. */
  locationId: z.uuid().nullable(),
  /** Exactly one of productId and categoryId. */
  productId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  kind: z.enum(PRICE_RULE_KINDS),
  /** `fixed`: the price (2 decimals); `percent_off`: the percentage (2 decimals). */
  value: z.string(),
  /** Weekdays it applies on (of the start, for hours past midnight); empty: every day. */
  days: z.array(z.enum(WEEKDAYS)),
  /** Local `HH:mm`; both or neither. `endsAt` before `startsAt` runs past midnight. */
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  /** Local dates, inclusive; either may be open. */
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  active: z.boolean(),
});

const ruleFields = {
  name: z.string().trim().min(1).max(PRICE_RULE_NAME_MAX_LENGTH),
  locationId: z.uuid().nullable(),
  productId: z.uuid().nullable(),
  categoryId: z.uuid().nullable(),
  kind: z.enum(PRICE_RULE_KINDS),
  value: z.string(),
  days: z
    .array(z.enum(WEEKDAYS))
    .max(7)
    .refine((d) => new Set(d).size === d.length, 'A day is listed twice'),
  startsAt: localTime.nullable(),
  endsAt: localTime.nullable(),
  validFrom: localDate.nullable(),
  validUntil: localDate.nullable(),
  active: z.boolean(),
};

export const createPriceRuleRequestSchema = z.strictObject({
  ...ruleFields,
  locationId: ruleFields.locationId.default(null),
  productId: ruleFields.productId.default(null),
  categoryId: ruleFields.categoryId.default(null),
  days: ruleFields.days.default([]),
  startsAt: ruleFields.startsAt.default(null),
  endsAt: ruleFields.endsAt.default(null),
  validFrom: ruleFields.validFrom.default(null),
  validUntil: ruleFields.validUntil.default(null),
  active: ruleFields.active.default(true),
});

export const updatePriceRuleRequestSchema = z
  .strictObject({
    name: ruleFields.name.optional(),
    locationId: ruleFields.locationId.optional(),
    productId: ruleFields.productId.optional(),
    categoryId: ruleFields.categoryId.optional(),
    kind: ruleFields.kind.optional(),
    value: ruleFields.value.optional(),
    days: ruleFields.days.optional(),
    startsAt: ruleFields.startsAt.optional(),
    endsAt: ruleFields.endsAt.optional(),
    validFrom: ruleFields.validFrom.optional(),
    validUntil: ruleFields.validUntil.optional(),
    active: ruleFields.active.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });

export const PRICE_RULE_PROBLEMS = [
  'target',
  'percent_on_product',
  'value',
  'hours',
  'dates',
] as const;
export type PriceRuleProblem = (typeof PRICE_RULE_PROBLEMS)[number];

type RuleShape = Pick<
  PriceRule,
  'productId' | 'categoryId' | 'kind' | 'value' | 'startsAt' | 'endsAt' | 'validFrom' | 'validUntil'
>;

/**
 * What is wrong with a whole rule (create, or an update merged onto the stored rule), or null. The
 * api refuses with `catalog.price_rule_invalid` and these problems; the web shows them inline.
 */
export function priceRuleProblems(rule: RuleShape): PriceRuleProblem[] {
  const problems: PriceRuleProblem[] = [];
  if ((rule.productId === null) === (rule.categoryId === null)) problems.push('target');
  if (rule.kind === 'percent_off' && rule.productId !== null) problems.push('percent_on_product');
  const valueOk =
    rule.kind === 'fixed'
      ? priceSchema.safeParse(rule.value).success
      : percentSchema.safeParse(rule.value).success;
  if (!valueOk) problems.push('value');
  if (
    (rule.startsAt === null) !== (rule.endsAt === null) ||
    (rule.startsAt !== null && rule.startsAt === rule.endsAt)
  ) {
    problems.push('hours');
  }
  if (rule.validFrom !== null && rule.validUntil !== null && rule.validFrom > rule.validUntil) {
    problems.push('dates');
  }
  return problems;
}

export const priceRuleListResponseSchema = z.object({ data: z.array(priceRuleSchema) });

/** `GET /catalog/prices`: what each product costs at a location at one moment. */
export const pricesQuerySchema = z.object({
  locationId: z.uuid(),
  /** An instant to check; default now. */
  at: z.iso.datetime().optional(),
  /** `false`: the regular location price, without time rules (margins). */
  timed: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
});

export const effectivePriceSchema = z.object({
  productId: z.uuid(),
  /** 2 decimals. */
  price: z.string(),
  /** The rule that set it; null: the product's own price. */
  ruleId: z.uuid().nullable(),
  ruleName: z.string().nullable(),
  /** Set by a time rule (happy hour, promotion). */
  timed: z.boolean(),
});

export const pricesResponseSchema = z.object({
  locationId: z.uuid(),
  at: z.iso.datetime(),
  data: z.array(effectivePriceSchema),
});

export type PriceRule = z.infer<typeof priceRuleSchema>;
export type CreatePriceRuleRequest = z.infer<typeof createPriceRuleRequestSchema>;
export type UpdatePriceRuleRequest = z.infer<typeof updatePriceRuleRequestSchema>;
export type PricesQuery = z.infer<typeof pricesQuerySchema>;
export type EffectivePrice = z.infer<typeof effectivePriceSchema>;
export type PricesResponse = z.infer<typeof pricesResponseSchema>;
