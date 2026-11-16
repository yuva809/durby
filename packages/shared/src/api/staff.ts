import { z } from 'zod';
import { FEATURE_KEYS, type FeatureKey, PLAN_KEYS } from '../features';
import { isLocalDate } from '../time/zoned';
import { PLATFORM_AUDIT_ACTION_KEYS } from '../platform-audit';
import { STAFF_PERMISSION_KEYS, STAFF_ROLES } from '../staff-permissions';
import { newPasswordSchema, PASSWORD_MAX_LENGTH } from './auth';

/** Request and response bodies of /api/v1/platform (docs/platform/admin-portal.md → API). */

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
/** 32 random bytes, base64url (43 characters). */
const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const staffRoleSchema = z.enum(STAFF_ROLES);

export const staffLoginRequestSchema = z.strictObject({
  email,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const staffAcceptRequestSchema = z.strictObject({
  token: opaqueToken,
  password: newPasswordSchema,
});

export const staffReauthRequestSchema = z.strictObject({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const staffMeResponseSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: staffRoleSchema,
  permissions: z.array(z.enum(STAFF_PERMISSION_KEYS)),
  /** Until when sensitive actions need no re-confirmation; null when not fresh. */
  freshUntil: z.iso.datetime().nullable(),
});

export const staffMemberSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: staffRoleSchema,
  status: z.enum(['invited', 'active', 'deactivated']),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const staffListResponseSchema = z.object({ data: z.array(staffMemberSchema) });

export const inviteStaffRequestSchema = z.strictObject({ email, role: staffRoleSchema });

export const updateStaffRequestSchema = z.strictObject({ role: staffRoleSchema });

function featureKeySchema() {
  return z.enum(FEATURE_KEYS as unknown as [FeatureKey, ...FeatureKey[]]);
}

/** Customers (docs/platform/admin-portal.md → Customers, Onboarding). */
export const CUSTOMER_NAME_MAX_LENGTH = 100;
export const OWNER_LOCALES = ['en', 'de'] as const;

export const partnerSummarySchema = z.object({ id: z.uuid(), slug: z.string(), name: z.string() });

export const customerSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  partner: partnerSummarySchema,
  plan: z.enum(PLAN_KEYS),
  createdAt: z.iso.datetime(),
});

export const customerDetailSchema = customerSummarySchema.extend({
  /** `invited` until the owner has set a password. Null if the organization has no owner. */
  owner: z.object({ email: z.string(), status: z.enum(['invited', 'active']) }).nullable(),
});

export const customerListQuerySchema = z.object({ query: z.string().trim().max(100).optional() });
export const customerListResponseSchema = z.object({ data: z.array(customerSummarySchema) });

export const onboardCustomerRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(CUSTOMER_NAME_MAX_LENGTH),
  ownerEmail: email,
  ownerLocale: z.enum(OWNER_LOCALES).default('en'),
  plan: z.enum(PLAN_KEYS).default('full'),
  /** Default: the default partner (Durby). */
  partnerId: z.uuid().optional(),
  /** Create even though the name or the owner email is already known (business rules: warn, confirm). */
  confirmDuplicates: z.boolean().default(false),
  /**
   * Modules and sub-features to switch on or off (admin portal 1d). Keys that differ from the
   * chosen plan are stored as overrides with reason "onboarding"; absent keys follow the plan.
   */
  features: z.partialRecord(featureKeySchema(), z.boolean()).optional(),
});

export const onboardingOptionsResponseSchema = z.object({
  partners: z.array(partnerSummarySchema),
  defaultPartnerId: z.uuid().nullable(),
  plans: z.array(z.enum(PLAN_KEYS)),
});

/** Modules per customer (docs/platform/admin-portal.md → Modules, step 1d). */
export const OVERRIDE_REASON_MAX_LENGTH = 500;

const overrideReason = z.string().trim().min(1).max(OVERRIDE_REASON_MAX_LENGTH);

/** A calendar day `YYYY-MM-DD`: the override ends with it in Europe/Berlin (berlinEndOfDay). */
export const expiryDaySchema = z.string().refine(isLocalDate, { message: 'Expected YYYY-MM-DD' });

export const catalogFeatureSchema = z.object({
  key: featureKeySchema(),
  /** Label keys; the portal translates them. */
  label: z.string(),
  description: z.string(),
  dependsOn: z.array(featureKeySchema()),
  order: z.int(),
  /** Limit names of the feature's schema, e.g. `maxLocations`. */
  limits: z.array(z.string()),
});

/** One card in the portal: the module key and its sub-features, both in `order`. */
export const catalogModuleSchema = catalogFeatureSchema.extend({
  features: z.array(catalogFeatureSchema),
});

export const featureCatalogResponseSchema = z.object({
  modules: z.array(catalogModuleSchema),
  /** Which features each plan includes (pre-ticks onboarding, shows "Plan" badges). */
  plans: z.array(
    z.object({ key: z.enum(PLAN_KEYS), label: z.string(), features: z.array(featureKeySchema()) }),
  ),
});

export const FEATURE_SOURCES = ['plan', 'override', 'dependency', 'expired-override'] as const;

export const customerFeatureSchema = z.object({
  key: featureKeySchema(),
  /** Effective: switched on (plan or override) and every dependency on. */
  enabled: z.boolean(),
  inPlan: z.boolean(),
  source: z.enum(FEATURE_SOURCES),
  override: z
    .object({
      enabled: z.boolean(),
      limits: z.record(z.string(), z.number()).nullable(),
      reason: z.string().nullable(),
      /** The Berlin day it ends with; null: no end. */
      expiresOn: expiryDaySchema.nullable(),
      expired: z.boolean(),
      /** Null for CLI and migration writes; `email` null if the account is gone. */
      setBy: z.object({ id: z.uuid(), email: z.string().nullable() }).nullable(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  /** Dependencies that are off while this feature is switched on. */
  blockedBy: z.array(featureKeySchema()),
});

export const customerEntitlementsSchema = z.object({
  customerId: z.uuid(),
  plan: z.enum(PLAN_KEYS),
  /** Every registered feature, in registry order. */
  features: z.array(customerFeatureSchema),
});

export const setPlanRequestSchema = z.strictObject({
  plan: z.enum(PLAN_KEYS),
  reason: overrideReason,
});

export const setFeatureRequestSchema = z.strictObject({
  enabled: z.boolean(),
  /** Only with `enabled`; checked against the feature's limits schema by the api. */
  limits: z.record(z.string(), z.unknown()).optional(),
  reason: overrideReason,
  expiresOn: expiryDaySchema.optional(),
});

export const resetFeatureRequestSchema = z.strictObject({ reason: overrideReason });

export const platformAuditEntrySchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  action: z.enum(PLATFORM_AUDIT_ACTION_KEYS),
  /** Staff email, or a system actor key; null when the staff account is gone. */
  actor: z.object({ type: z.enum(['staff', 'system']), name: z.string().nullable() }),
  entityType: z.string(),
  entityId: z.uuid(),
  organizationId: z.uuid().nullable(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});

export const platformAuditQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const platformAuditResponseSchema = z.object({
  data: z.array(platformAuditEntrySchema),
  /** Pass as `cursor` for the next (older) page; null at the end. */
  nextCursor: z.uuid().nullable(),
});

/** Stable error codes of /api/v1/platform; the web app shows the matching label. */
export const STAFF_ERROR_CODES = [
  'staff.unauthenticated',
  'staff.invalid_credentials',
  'staff.reauth_required',
  'staff.permission_denied',
  'staff.invitation_invalid',
  'staff.email_domain',
  'staff.not_found',
  'staff.already_active',
  'staff.last_super_admins',
  'staff.cannot_change_self',
  'staff.customer_duplicate',
  'staff.customer_not_found',
  'staff.owner_active',
  'staff.partner_not_found',
  'staff.feature_unknown',
  'staff.feature_limits_invalid',
  'staff.expiry_past',
  'staff.feature_dependency_missing',
  'staff.feedback_not_found',
] as const;

export type StaffErrorCode = (typeof STAFF_ERROR_CODES)[number];

/** `staff.last_super_admins` → `staff.errors.lastSuperAdmins`. */
export function staffErrorLabel(code: StaffErrorCode): string {
  return `staff.errors.${code.slice('staff.'.length).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

export type StaffLoginRequest = z.infer<typeof staffLoginRequestSchema>;
export type StaffAcceptRequest = z.infer<typeof staffAcceptRequestSchema>;
export type StaffReauthRequest = z.infer<typeof staffReauthRequestSchema>;
export type StaffMeResponse = z.infer<typeof staffMeResponseSchema>;
export type StaffMember = z.infer<typeof staffMemberSchema>;
export type StaffListResponse = z.infer<typeof staffListResponseSchema>;
export type InviteStaffRequest = z.infer<typeof inviteStaffRequestSchema>;
export type UpdateStaffRequest = z.infer<typeof updateStaffRequestSchema>;
export type PartnerSummary = z.infer<typeof partnerSummarySchema>;
export type CustomerSummary = z.infer<typeof customerSummarySchema>;
export type CustomerDetail = z.infer<typeof customerDetailSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
export type CustomerListResponse = z.infer<typeof customerListResponseSchema>;
export type OnboardCustomerRequest = z.input<typeof onboardCustomerRequestSchema>;
export type OnboardCustomerBody = z.output<typeof onboardCustomerRequestSchema>;
export type OnboardingOptionsResponse = z.infer<typeof onboardingOptionsResponseSchema>;
export type PlatformAuditEntry = z.infer<typeof platformAuditEntrySchema>;
export type CatalogFeature = z.infer<typeof catalogFeatureSchema>;
export type CatalogModule = z.infer<typeof catalogModuleSchema>;
export type FeatureCatalogResponse = z.infer<typeof featureCatalogResponseSchema>;
export type FeatureSourceKind = (typeof FEATURE_SOURCES)[number];
export type CustomerFeature = z.infer<typeof customerFeatureSchema>;
export type CustomerEntitlements = z.infer<typeof customerEntitlementsSchema>;
export type SetPlanRequest = z.infer<typeof setPlanRequestSchema>;
export type SetFeatureRequest = z.infer<typeof setFeatureRequestSchema>;
export type ResetFeatureRequest = z.infer<typeof resetFeatureRequestSchema>;
export type PlatformAuditQuery = z.infer<typeof platformAuditQuerySchema>;
export type PlatformAuditResponse = z.infer<typeof platformAuditResponseSchema>;
