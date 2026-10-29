import { z } from 'zod';
import { PLAN_KEYS } from '../features';
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
});

export const onboardingOptionsResponseSchema = z.object({
  partners: z.array(partnerSummarySchema),
  defaultPartnerId: z.uuid().nullable(),
  plans: z.array(z.enum(PLAN_KEYS)),
});

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
export type PlatformAuditQuery = z.infer<typeof platformAuditQuerySchema>;
export type PlatformAuditResponse = z.infer<typeof platformAuditResponseSchema>;
