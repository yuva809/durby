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
  'setting_value',
  'label_override',
  'number_series',
  'number_series_counter',
  'outbox_event',
  'product_category',
  'product',
  'dining_table',
  'pos_order',
  'kitchen_ticket',
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
  'platform.organization.updated': {
    entityType: 'organization',
    label: 'platform.audit.actions.organizationUpdated',
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
  'platform.setting_value.created': {
    entityType: 'setting_value',
    label: 'platform.audit.actions.settingValueCreated',
  },
  'platform.setting_value.updated': {
    entityType: 'setting_value',
    label: 'platform.audit.actions.settingValueUpdated',
  },
  'platform.setting_value.deleted': {
    entityType: 'setting_value',
    label: 'platform.audit.actions.settingValueDeleted',
  },
  'platform.label_override.created': {
    entityType: 'label_override',
    label: 'platform.audit.actions.labelOverrideCreated',
  },
  'platform.label_override.updated': {
    entityType: 'label_override',
    label: 'platform.audit.actions.labelOverrideUpdated',
  },
  'platform.label_override.deleted': {
    entityType: 'label_override',
    label: 'platform.audit.actions.labelOverrideDeleted',
  },
  'platform.number_series.updated': {
    entityType: 'number_series',
    label: 'platform.audit.actions.numberSeriesUpdated',
  },
  'platform.number_series_counter.raised': {
    entityType: 'number_series_counter',
    label: 'platform.audit.actions.numberSeriesCounterRaised',
  },
  /** A dead-lettered event or a failed handler job re-queued by the outbox CLI (ADR 0013). */
  'platform.outbox_event.retried': {
    entityType: 'outbox_event',
    label: 'platform.audit.actions.outboxEventRetried',
  },
  'catalog.product_category.created': {
    entityType: 'product_category',
    label: 'catalog.audit.actions.productCategoryCreated',
  },
  'catalog.product_category.updated': {
    entityType: 'product_category',
    label: 'catalog.audit.actions.productCategoryUpdated',
  },
  'catalog.product.created': {
    entityType: 'product',
    label: 'catalog.audit.actions.productCreated',
  },
  'catalog.product.updated': {
    entityType: 'product',
    label: 'catalog.audit.actions.productUpdated',
  },
  'pos.dining_table.created': {
    entityType: 'dining_table',
    label: 'pos.audit.actions.diningTableCreated',
  },
  'pos.dining_table.updated': {
    entityType: 'dining_table',
    label: 'pos.audit.actions.diningTableUpdated',
  },
  'pos.order.opened': { entityType: 'pos_order', label: 'pos.audit.actions.orderOpened' },
  'pos.order.closed': { entityType: 'pos_order', label: 'pos.audit.actions.orderClosed' },
  'pos.kitchen_ticket.created': {
    entityType: 'kitchen_ticket',
    label: 'pos.audit.actions.kitchenTicketCreated',
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
  'cli.outbox': { label: 'platform.audit.actors.cliOutbox' },
  /** Outbox handlers (ADR 0013), when one records audit rows. */
  'job.outbox': { label: 'platform.audit.actors.jobOutbox' },
  migration: { label: 'platform.audit.actors.migration' },
} as const satisfies Record<string, { label: string }>;

export type AuditSystemActor = keyof typeof AUDIT_SYSTEM_ACTORS;

export const AUDIT_SYSTEM_ACTOR_KEYS = Object.keys(
  AUDIT_SYSTEM_ACTORS,
) as readonly AuditSystemActor[];

export function auditEntityLabel(type: AuditEntityType): string {
  return `platform.audit.entities.${type.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

/**
 * The only fields that can ever reach `before`/`after` (ADR 0008 §5), per entity type. Never add
 * password or token hashes, tokens, links or email addresses: audit rows can't be updated or erased.
 */
export const AUDIT_SNAPSHOT_FIELDS = {
  organization: ['id', 'partnerId', 'name', 'planId'],
  role: ['id', 'systemKey', 'name', 'permissions'],
  membership: ['id', 'userId', 'roleId', 'allLocations', 'locationIds'],
  invitation: [
    'id',
    'roleId',
    'allLocations',
    'locationIds',
    'expiresAt',
    'acceptedAt',
    'acceptedByUserId',
    'revokedAt',
  ],
  session: ['organizationId', 'previousOrganizationId'],
  /** `limits`: canonical JSON string (sorted keys); snapshots hold flat values only. */
  feature_override: ['id', 'featureKey', 'enabled', 'limits'],
  /** `features`: sorted keys, `key:<canonical limits json>` where a plan sets limits. */
  plan: ['id', 'key', 'features'],
  /** `value`: canonical JSON string (sorted keys). Settings never hold secrets (ADR 0010). */
  setting_value: ['id', 'key', 'scopeType', 'brandId', 'locationId', 'value'],
  /** Label text is plain text, never a secret (ADR 0011). */
  label_override: ['id', 'locale', 'key', 'value'],
  number_series: ['id', 'key', 'prefix', 'pattern', 'resetPolicy'],
  /** `nextValue` as a string of digits (bigint). */
  number_series_counter: ['id', 'seriesKey', 'period', 'nextValue'],
  /** Never `payload` or `lastError`. `handler`: set when one failed handler job was re-queued. */
  outbox_event: ['id', 'type', 'version', 'attempts', 'deadLetteredAt', 'handler'],
  product_category: ['id', 'name', 'sortOrder', 'archivedAt'],
  /** `price`, `taxRate`: decimal strings. Never `description` (free text). */
  product: ['id', 'categoryId', 'name', 'price', 'taxRate', 'sortOrder', 'archivedAt'],
  dining_table: [
    'id',
    'locationId',
    'name',
    'seats',
    'area',
    'shape',
    'color',
    'sortOrder',
    'archivedAt',
  ],
  pos_order: ['id', 'number', 'tableId', 'locationId', 'status', 'closedAt'],
  /** Never line notes (free text). */
  kitchen_ticket: ['id', 'orderId', 'sequence', 'kind', 'lineCount'],
} as const satisfies Record<AuditEntityType, readonly string[]>;
