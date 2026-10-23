import { z } from 'zod';
import { FEATURE_KEYS } from '../features';

/** Response body of GET /api/v1/me/entitlements (docs/platform/entitlements.md). UI hints only. */

export const entitlementFeatureSchema = z.object({
  key: z.enum(FEATURE_KEYS),
  /** Every limit of the feature's schema; null = unlimited. */
  limits: z.record(z.string(), z.int().positive().nullable()),
});

export const meEntitlementsResponseSchema = z.object({
  /** Display name: the label `planLabel(key)`. null without a plan or active organization. */
  plan: z.object({ key: z.string() }).nullable(),
  /** Enabled features only, in registry order. */
  features: z.array(entitlementFeatureSchema),
});

export type EntitlementFeature = z.infer<typeof entitlementFeatureSchema>;
export type MeEntitlementsResponse = z.infer<typeof meEntitlementsResponseSchema>;

/** Stable error codes of entitlements; the web app shows the matching label. */
export const ENTITLEMENT_ERROR_CODES = ['entitlements.feature_disabled'] as const;

export type EntitlementErrorCode = (typeof ENTITLEMENT_ERROR_CODES)[number];
