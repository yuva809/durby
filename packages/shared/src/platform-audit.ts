/**
 * Platform audit registries (docs/platform/admin-portal.md, ADR 0017 §7): every Durby staff
 * action, outside any tenant. Actions are never free-form strings.
 *
 * Adding an action: `staff.entity.past_tense`, an entity type, and a label key with `en` and `de`
 * defaults in packages/i18n (a test fails without them).
 */

export const PLATFORM_AUDIT_ENTITY_TYPES = [
  'staff_account',
  'organization',
  'feature_override',
  'feedback',
] as const;

export type PlatformAuditEntityType = (typeof PLATFORM_AUDIT_ENTITY_TYPES)[number];

export const PLATFORM_AUDIT_ACTIONS = {
  'staff.account.invited': { entityType: 'staff_account', label: 'staff.audit.actions.invited' },
  'staff.account.activated': {
    entityType: 'staff_account',
    label: 'staff.audit.actions.activated',
  },
  'staff.account.role_changed': {
    entityType: 'staff_account',
    label: 'staff.audit.actions.roleChanged',
  },
  'staff.account.deactivated': {
    entityType: 'staff_account',
    label: 'staff.audit.actions.deactivated',
  },
  'staff.session.logged_in': {
    entityType: 'staff_account',
    label: 'staff.audit.actions.loggedIn',
  },
  /** A new customer: organization, system roles, number series and Owner membership (step 1c). */
  'staff.customer.onboarded': {
    entityType: 'organization',
    label: 'staff.audit.actions.customerOnboarded',
  },
  'staff.customer.owner_invited': {
    entityType: 'organization',
    label: 'staff.audit.actions.ownerInvited',
  },
  /** Admin portal 1d: a customer's plan and module switches, each with the staff member's reason. */
  'staff.customer.plan_changed': {
    entityType: 'organization',
    label: 'staff.audit.actions.planChanged',
  },
  'staff.feature_override.created': {
    entityType: 'feature_override',
    label: 'staff.audit.actions.featureOverrideCreated',
  },
  'staff.feature_override.updated': {
    entityType: 'feature_override',
    label: 'staff.audit.actions.featureOverrideUpdated',
  },
  'staff.feature_override.deleted': {
    entityType: 'feature_override',
    label: 'staff.audit.actions.featureOverrideDeleted',
  },
  /** A customer's feedback marked seen or done (ADR 0044 step 5). */
  'staff.feedback.status_changed': {
    entityType: 'feedback',
    label: 'staff.audit.actions.feedbackStatusChanged',
  },
} as const satisfies Record<string, { entityType: PlatformAuditEntityType; label: string }>;

export type PlatformAuditAction = keyof typeof PLATFORM_AUDIT_ACTIONS;

export const PLATFORM_AUDIT_ACTION_KEYS = Object.keys(
  PLATFORM_AUDIT_ACTIONS,
) as readonly PlatformAuditAction[];

/** Actors that are not staff members. */
export const PLATFORM_AUDIT_SYSTEM_ACTORS = {
  'cli.create_staff': { label: 'staff.audit.actors.cliCreateStaff' },
  /** The local/CI demo staff account (apps/api/src/cli/seed-dev.ts); never on staging or prod. */
  'cli.seed_dev': { label: 'staff.audit.actors.cliSeedDev' },
} as const satisfies Record<string, { label: string }>;

export type PlatformAuditSystemActor = keyof typeof PLATFORM_AUDIT_SYSTEM_ACTORS;

/** The only fields that can reach `before`/`after`. Never emails, hashes or secrets. */
export const PLATFORM_AUDIT_SNAPSHOT_FIELDS = {
  staff_account: ['id', 'role', 'status'],
  organization: ['id', 'partnerId', 'name', 'planId'],
  /** `limits`: canonical JSON string; `expiresAt`: ISO. The reason goes in the row's `reason`. */
  feature_override: ['id', 'featureKey', 'enabled', 'limits', 'expiresAt'],
  /** Never the message (free text from the customer). */
  feedback: ['id', 'category', 'status'],
} as const satisfies Record<PlatformAuditEntityType, readonly string[]>;
