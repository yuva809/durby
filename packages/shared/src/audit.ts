/**
 * Audit registries (docs/platform/audit.md, ADR 0008). Actions are never free-form strings: the api
 * records only keys of AUDIT_ACTIONS, and takes the entity type from the action's entry.
 *
 * Adding an action: `module.entity.past_tense`, an entity type, and a label key with `en` and `de`
 * defaults in packages/i18n (a test fails without them).
 */

/** Entity types an audit row can point at. Labels: `platform.audit.entities.<camelCaseType>`. */
export const AUDIT_ENTITY_TYPES = [
  'organization',
  'role',
  'membership',
  'invitation',
  'session',
  'feature_override',
  'plan',
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export interface AuditActionDefinition {
  entityType: AuditEntityType;
  /** Label key of the action's display name. */
  label: string;
}

export const AUDIT_ACTIONS = {
  'platform.organization.created': {
    entityType: 'organization',
    label: 'platform.audit.actions.organizationCreated',
  },
  'platform.role.created': { entityType: 'role', label: 'platform.audit.actions.roleCreated' },
  'platform.role.updated': { entityType: 'role', label: 'platform.audit.actions.roleUpdated' },
  'platform.role.deleted': { entityType: 'role', label: 'platform.audit.actions.roleDeleted' },
  'platform.membership.created': {
    entityType: 'membership',
    label: 'platform.audit.actions.membershipCreated',
  },
  'platform.membership.updated': {
    entityType: 'membership',
    label: 'platform.audit.actions.membershipUpdated',
  },
  'platform.membership.removed': {
    entityType: 'membership',
    label: 'platform.audit.actions.membershipRemoved',
  },
  'platform.invitation.created': {
    entityType: 'invitation',
    label: 'platform.audit.actions.invitationCreated',
  },
  'platform.invitation.revoked': {
    entityType: 'invitation',
    label: 'platform.audit.actions.invitationRevoked',
  },
  'platform.invitation.accepted': {
    entityType: 'invitation',
    label: 'platform.audit.actions.invitationAccepted',
  },
  'platform.session.organization_switched': {
    entityType: 'session',
    label: 'platform.audit.actions.sessionOrganizationSwitched',
  },
  'platform.organization.plan_changed': {
    entityType: 'organization',
    label: 'platform.audit.actions.organizationPlanChanged',
  },
  'platform.feature_override.created': {
    entityType: 'feature_override',
    label: 'platform.audit.actions.featureOverrideCreated',
  },
  'platform.feature_override.updated': {
    entityType: 'feature_override',
    label: 'platform.audit.actions.featureOverrideUpdated',
  },
  'platform.feature_override.deleted': {
    entityType: 'feature_override',
    label: 'platform.audit.actions.featureOverrideDeleted',
  },
  /** Written per organization on the plan by a migration that changes plan contents (ADR 0009). */
  'platform.plan.features_changed': {
    entityType: 'plan',
    label: 'platform.audit.actions.planFeaturesChanged',
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const AUDIT_ACTION_KEYS = Object.keys(AUDIT_ACTIONS) as readonly AuditAction[];

/** The entity type an action is recorded against. */
export type AuditActionEntityType<A extends AuditAction> = (typeof AUDIT_ACTIONS)[A]['entityType'];

/** Same shape as the `audit_logs_action_format_check` constraint: open-ended, so keys may grow. */
export const AUDIT_ACTION_PATTERN = /^[a-z]+(\.[a-z_]+){2,}$/;

export function isAuditAction(value: string): value is AuditAction {
  return Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, value);
}

/** Actors that are not users: bootstrap commands, data migrations, later `job.<name>`. */
export const AUDIT_SYSTEM_ACTORS = {
  'cli.create_admin': { label: 'platform.audit.actors.cliCreateAdmin' },
  'cli.seed_dev': { label: 'platform.audit.actors.cliSeedDev' },
  'cli.entitlements': { label: 'platform.audit.actors.cliEntitlements' },
  migration: { label: 'platform.audit.actors.migration' },
} as const satisfies Record<string, { label: string }>;

export type AuditSystemActor = keyof typeof AUDIT_SYSTEM_ACTORS;

export const AUDIT_SYSTEM_ACTOR_KEYS = Object.keys(
  AUDIT_SYSTEM_ACTORS,
) as readonly AuditSystemActor[];

export function auditEntityLabel(type: AuditEntityType): string {
  return `platform.audit.entities.${type.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
