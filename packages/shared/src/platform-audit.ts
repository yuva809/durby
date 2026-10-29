/**
 * Platform audit registries (docs/platform/admin-portal.md, ADR 0017 §7): every Durby staff
 * action, outside any tenant. Actions are never free-form strings.
 *
 * Adding an action: `staff.entity.past_tense`, an entity type, and a label key with `en` and `de`
 * defaults in packages/i18n (a test fails without them).
 */

export const PLATFORM_AUDIT_ENTITY_TYPES = ['staff_account', 'organization'] as const;

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
} as const satisfies Record<string, { entityType: PlatformAuditEntityType; label: string }>;

export type PlatformAuditAction = keyof typeof PLATFORM_AUDIT_ACTIONS;

export const PLATFORM_AUDIT_ACTION_KEYS = Object.keys(
  PLATFORM_AUDIT_ACTIONS,
) as readonly PlatformAuditAction[];

/** Actors that are not staff members. */
export const PLATFORM_AUDIT_SYSTEM_ACTORS = {
  'cli.create_staff': { label: 'staff.audit.actors.cliCreateStaff' },
} as const satisfies Record<string, { label: string }>;

export type PlatformAuditSystemActor = keyof typeof PLATFORM_AUDIT_SYSTEM_ACTORS;

/** The only fields that can reach `before`/`after`. Never emails, hashes or secrets. */
export const PLATFORM_AUDIT_SNAPSHOT_FIELDS = {
  staff_account: ['id', 'role', 'status'],
  organization: ['id', 'partnerId', 'name', 'planId'],
} as const satisfies Record<PlatformAuditEntityType, readonly string[]>;
