/**
 * Feature key registry (`module.capability`). Populated in step 1.5.
 * See docs/architecture/ARCHITECTURE.md → Config resolution.
 */
export const FEATURE_KEYS = [] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
