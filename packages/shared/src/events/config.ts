import { z } from 'zod';
import { SETTING_KEY_PATTERN, TENANT_SETTING_SCOPES } from '../settings';

/**
 * Config change events (docs/platform/outbox.md, ADR 0013 §7). Emitted by the writers in the
 * change's transaction, only when something changed. No handlers yet: config caches are per request.
 */

/** Dotted registry or label key (`billing.invoice`, `inventory.nav.title`). */
const configKey = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/)
  .max(200);

/** Setting keys may be a single word (`timezone`), see SETTING_KEY_PATTERN. */
const settingKey = z.string().regex(SETTING_KEY_PATTERN).max(100);

export const configSettingsChangedV1 = z.strictObject({
  scope: z.enum(TENANT_SETTING_SCOPES),
  /** The organization, brand or location id of the scope. */
  scopeId: z.uuid(),
  key: settingKey,
});

export const configLabelsChangedV1 = z.strictObject({
  locale: z.string().regex(/^[a-z]{2}$/),
  key: configKey,
});

export const configNumberSeriesChangedV1 = z.strictObject({
  key: configKey,
  change: z.enum(['format', 'counter']),
});

/** The organization's plan or overrides changed; consumers reload all of it. */
export const configEntitlementsChangedV1 = z.strictObject({});
