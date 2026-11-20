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
  'dining_area',
  'location',
  'reservation_table_rule',
  'reservation_combination',
  'reservation',
  'warehouse',
  'stock_item',
  'stock_document',
  'recipe',
  'price_rule',
  'reservation_guest',
  'printer_command',
  'printer',
  'print_job',
  'pos_bill',
  'pos_discount',
  'unit_of_measure',
  'variant_attribute',
  'bom',
  'customer',
  'sales_order',
  'stock_request',
  'vendor_invoice',
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
  'platform.membership.deactivated': {
    entityType: 'membership',
    label: 'platform.audit.actions.membershipDeactivated',
  },
  'platform.membership.reactivated': {
    entityType: 'membership',
    label: 'platform.audit.actions.membershipReactivated',
  },
  // An owner or admin set the member's password (ADR 0052); never the password itself.
  'platform.membership.password_set': {
    entityType: 'membership',
    label: 'platform.audit.actions.membershipPasswordSet',
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
  'platform.invitation.link_renewed': {
    entityType: 'invitation',
    label: 'platform.audit.actions.invitationLinkRenewed',
  },
  'platform.session.organization_switched': {
    entityType: 'session',
    label: 'platform.audit.actions.sessionOrganizationSwitched',
  },
  'platform.organization.updated': {
    entityType: 'organization',
    label: 'platform.audit.actions.organizationUpdated',
  },
  'platform.location.created': {
    entityType: 'location',
    label: 'platform.audit.actions.locationCreated',
  },
  'platform.location.updated': {
    entityType: 'location',
    label: 'platform.audit.actions.locationUpdated',
  },
  'platform.location.deleted': {
    entityType: 'location',
    label: 'platform.audit.actions.locationDeleted',
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
  // ADR 0051: the migration that copied stored keys onto their split keys (actor `migration`).
  'platform.permission_keys.split': {
    entityType: 'organization',
    label: 'platform.audit.actions.permissionKeysSplit',
  },
  // ADR 0060: the migration that gave every custom role a new key its members had in effect (actor `migration`).
  'platform.permission_keys.added': {
    entityType: 'organization',
    label: 'platform.audit.actions.permissionKeysAdded',
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
  'catalog.product.deleted': {
    entityType: 'product',
    label: 'catalog.audit.actions.productDeleted',
  },
  'catalog.product_category.deleted': {
    entityType: 'product_category',
    label: 'catalog.audit.actions.productCategoryDeleted',
  },
  'catalog.product.updated': {
    entityType: 'product',
    label: 'catalog.audit.actions.productUpdated',
  },
  'catalog.price_rule.created': {
    entityType: 'price_rule',
    label: 'catalog.audit.actions.priceRuleCreated',
  },
  'catalog.price_rule.updated': {
    entityType: 'price_rule',
    label: 'catalog.audit.actions.priceRuleUpdated',
  },
  'catalog.price_rule.deleted': {
    entityType: 'price_rule',
    label: 'catalog.audit.actions.priceRuleDeleted',
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
  'pos.order.moved': { entityType: 'pos_order', label: 'pos.audit.actions.orderMoved' },
  'pos.order.merged': { entityType: 'pos_order', label: 'pos.audit.actions.orderMerged' },
  'pos.order.updated': { entityType: 'pos_order', label: 'pos.audit.actions.orderUpdated' },
  'pos.bill.created': { entityType: 'pos_bill', label: 'pos.audit.actions.billCreated' },
  'pos.bill.cancelled': { entityType: 'pos_bill', label: 'pos.audit.actions.billCancelled' },
  'pos.discount.added': { entityType: 'pos_discount', label: 'pos.audit.actions.discountAdded' },
  'pos.discount.voided': { entityType: 'pos_discount', label: 'pos.audit.actions.discountVoided' },
  'pos.kitchen_ticket.created': {
    entityType: 'kitchen_ticket',
    label: 'pos.audit.actions.kitchenTicketCreated',
  },
  /** Moved on the kitchen or bar screen, or served from the till (ADR 0026). */
  'pos.kitchen_ticket.status_changed': {
    entityType: 'kitchen_ticket',
    label: 'pos.audit.actions.kitchenTicketStatusChanged',
  },
  /** A new QR menu token; the token itself is never recorded. */
  'pos.dining_table.menu_token_rotated': {
    entityType: 'dining_table',
    label: 'pos.audit.actions.diningTableMenuTokenRotated',
  },
  'inventory.warehouse.created': {
    entityType: 'warehouse',
    label: 'inventory.audit.actions.warehouseCreated',
  },
  'inventory.warehouse.updated': {
    entityType: 'warehouse',
    label: 'inventory.audit.actions.warehouseUpdated',
  },
  'inventory.stock_item.created': {
    entityType: 'stock_item',
    label: 'inventory.audit.actions.stockItemCreated',
  },
  'inventory.stock_item.updated': {
    entityType: 'stock_item',
    label: 'inventory.audit.actions.stockItemUpdated',
  },
  /** A product's recipe was replaced (docs/modules/inventory.md → Recipes). */
  'inventory.recipe.updated': {
    entityType: 'recipe',
    label: 'inventory.audit.actions.recipeUpdated',
  },
  /** Units of measurement, variant attributes and bills of materials (ADR 0038). */
  'inventory.unit.created': {
    entityType: 'unit_of_measure',
    label: 'inventory.audit.actions.unitCreated',
  },
  'inventory.unit.updated': {
    entityType: 'unit_of_measure',
    label: 'inventory.audit.actions.unitUpdated',
  },
  'inventory.variant_attribute.created': {
    entityType: 'variant_attribute',
    label: 'inventory.audit.actions.variantAttributeCreated',
  },
  'inventory.variant_attribute.updated': {
    entityType: 'variant_attribute',
    label: 'inventory.audit.actions.variantAttributeUpdated',
  },
  'inventory.bom.updated': {
    entityType: 'bom',
    label: 'inventory.audit.actions.bomUpdated',
  },
  'inventory.bom.deleted': {
    entityType: 'bom',
    label: 'inventory.audit.actions.bomDeleted',
  },
  /** A receipt, adjustment or transfer was posted (docs/modules/inventory.md → Audit). */
  'inventory.stock_document.created': {
    entityType: 'stock_document',
    label: 'inventory.audit.actions.stockDocumentCreated',
  },
  /** Customers and sales orders (ADR 0044). */
  'orders.customer.created': {
    entityType: 'customer',
    label: 'orders.audit.actions.customerCreated',
  },
  'orders.customer.updated': {
    entityType: 'customer',
    label: 'orders.audit.actions.customerUpdated',
  },
  'orders.sales_order.created': {
    entityType: 'sales_order',
    label: 'orders.audit.actions.salesOrderCreated',
  },
  'orders.sales_order.updated': {
    entityType: 'sales_order',
    label: 'orders.audit.actions.salesOrderUpdated',
  },
  /** A status change: confirmed, cancelled (later: picked, packed, dispatched, delivered). */
  'orders.sales_order.status_changed': {
    entityType: 'sales_order',
    label: 'orders.audit.actions.salesOrderStatusChanged',
  },
  /** Vendor invoices (ADR 0054): read and submitted, changed while pending, then approved or rejected. */
  'inventory.vendor_invoice.submitted': {
    entityType: 'vendor_invoice',
    label: 'inventory.audit.actions.vendorInvoiceSubmitted',
  },
  'inventory.vendor_invoice.updated': {
    entityType: 'vendor_invoice',
    label: 'inventory.audit.actions.vendorInvoiceUpdated',
  },
  'inventory.vendor_invoice.approved': {
    entityType: 'vendor_invoice',
    label: 'inventory.audit.actions.vendorInvoiceApproved',
  },
  'inventory.vendor_invoice.rejected': {
    entityType: 'vendor_invoice',
    label: 'inventory.audit.actions.vendorInvoiceRejected',
  },
  /** Branch stock requests (ADR 0045): created, then each step of their life. */
  'orders.stock_request.created': {
    entityType: 'stock_request',
    label: 'orders.audit.actions.stockRequestCreated',
  },
  'orders.stock_request.status_changed': {
    entityType: 'stock_request',
    label: 'orders.audit.actions.stockRequestStatusChanged',
  },
  'pos.dining_area.created': {
    entityType: 'dining_area',
    label: 'pos.audit.actions.diningAreaCreated',
  },
  'pos.dining_area.updated': {
    entityType: 'dining_area',
    label: 'pos.audit.actions.diningAreaUpdated',
  },
  'pos.dining_area.deleted': {
    entityType: 'dining_area',
    label: 'pos.audit.actions.diningAreaDeleted',
  },
  // Printers per location (ADR 0033).
  'pos.printer.created': { entityType: 'printer', label: 'pos.audit.actions.printerCreated' },
  'pos.printer.updated': { entityType: 'printer', label: 'pos.audit.actions.printerUpdated' },
  'pos.printer.archived': { entityType: 'printer', label: 'pos.audit.actions.printerArchived' },
  // Print jobs (ADR 0033): queued with a ticket or a bill, claimed by a till, answered, reprinted.
  'pos.print_job.queued': { entityType: 'print_job', label: 'pos.audit.actions.printJobQueued' },
  'pos.print_job.claimed': { entityType: 'print_job', label: 'pos.audit.actions.printJobClaimed' },
  'pos.print_job.answered': {
    entityType: 'print_job',
    label: 'pos.audit.actions.printJobAnswered',
  },
  'pos.print_job.reprinted': {
    entityType: 'print_job',
    label: 'pos.audit.actions.printJobReprinted',
  },
  'pos.print_job.expired': { entityType: 'print_job', label: 'pos.audit.actions.printJobExpired' },
  // Remote printer commands (ADR 0032 §15): the audit log is their lasting record.
  'pos.printer_command.requested': {
    entityType: 'printer_command',
    label: 'pos.audit.actions.printerCommandRequested',
  },
  'pos.printer_command.claimed': {
    entityType: 'printer_command',
    label: 'pos.audit.actions.printerCommandClaimed',
  },
  'pos.printer_command.completed': {
    entityType: 'printer_command',
    label: 'pos.audit.actions.printerCommandCompleted',
  },
  /** entityId: the table's id (a rule is keyed by its table). */
  'reservations.table_rule.updated': {
    entityType: 'reservation_table_rule',
    label: 'reservations.audit.actions.tableRuleUpdated',
  },
  'reservations.combination.created': {
    entityType: 'reservation_combination',
    label: 'reservations.audit.actions.combinationCreated',
  },
  'reservations.combination.updated': {
    entityType: 'reservation_combination',
    label: 'reservations.audit.actions.combinationUpdated',
  },
  'reservations.reservation.created': {
    entityType: 'reservation',
    label: 'reservations.audit.actions.reservationCreated',
  },
  'reservations.reservation.updated': {
    entityType: 'reservation',
    label: 'reservations.audit.actions.reservationUpdated',
  },
  'reservations.reservation.status_changed': {
    entityType: 'reservation',
    label: 'reservations.audit.actions.reservationStatusChanged',
  },
  'reservations.reservation.status_undone': {
    entityType: 'reservation',
    label: 'reservations.audit.actions.reservationStatusUndone',
  },
  /** Staff `force`: booked past pacing or outside the reservation hours (`overriddenRules`). */
  'reservations.reservation.rules_overridden': {
    entityType: 'reservation',
    label: 'reservations.audit.actions.reservationRulesOverridden',
  },
  /** Erasure on request (R1.9): irreversible. */
  'reservations.guest.anonymised': {
    entityType: 'reservation_guest',
    label: 'reservations.audit.actions.guestAnonymised',
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
  /** Durby staff in the admin portal (ADR 0017); the platform audit log names the person. */
  'staff.admin_portal': { label: 'platform.audit.actors.adminPortal' },
  /** Outbox handlers (ADR 0013), when one records audit rows. */
  'job.outbox': { label: 'platform.audit.actors.jobOutbox' },
  /** The worker's hourly sweep of print jobs past their maximum age (ADR 0033 §12). */
  'job.print_jobs': { label: 'platform.audit.actors.jobPrintJobs' },
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
  /** rowsAdded: stored permission rows the ADR 0051 and ADR 0060 migrations added. */
  organization: ['id', 'partnerId', 'name', 'planId', 'rowsAdded'],
  role: ['id', 'systemKey', 'name', 'permissions'],
  /** grants/denies: per-member permission changes; active: false while deactivated (ADR 0023). */
  membership: [
    'id',
    'userId',
    'roleId',
    'allLocations',
    'locationIds',
    'warehouseIds',
    'grants',
    'denies',
    'active',
  ],
  invitation: [
    'id',
    'roleId',
    'allLocations',
    'locationIds',
    'grants',
    'denies',
    'expiresAt',
    'acceptedAt',
    'acceptedByUserId',
    'revokedAt',
  ],
  session: ['organizationId', 'previousOrganizationId'],
  /**
   * `limits`: canonical JSON string (sorted keys); snapshots hold flat values only. `reason`,
   * `expiresAt` (ISO) and `setByStaffId` from admin portal 1d: the customer's log shows who at
   * Durby set it and why, though the actor is `staff.admin_portal` (ADR 0017 §8).
   */
  feature_override: [
    'id',
    'featureKey',
    'enabled',
    'limits',
    'expiresAt',
    'reason',
    'setByStaffId',
  ],
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
  /**
   * `imageVersion`: when the tile image last changed (the bytes are never in the log); null = none. The description is
   * free text and stays out, as for products (ADR 0048).
   */
  product_category: [
    'id',
    'name',
    'sortOrder',
    'station',
    'parentId',
    'imageVersion',
    'archivedAt',
  ],
  /** `days`: comma-separated weekdays; `value`: decimal text. */
  price_rule: [
    'id',
    'name',
    'locationId',
    'productId',
    'categoryId',
    'kind',
    'value',
    'days',
    'startsAt',
    'endsAt',
    'validFrom',
    'validUntil',
    'active',
  ],
  /** `price`, `taxRate`: decimal strings. Never `description` (free text). */
  product: [
    'id',
    'categoryId',
    'name',
    'menuNumber',
    'price',
    'taxRate',
    'sortOrder',
    'archivedAt',
  ],
  /**
   * `floorX`, `floorY`: the table's place on the floor plan (0–1000). They must be listed here: the update compares
   * snapshots to skip no-op writes, so a field missing from this list is never saved on its own.
   */
  dining_table: [
    'id',
    'locationId',
    'name',
    'seats',
    'areaId',
    'area',
    'shape',
    'color',
    'sortOrder',
    'floorX',
    'floorY',
    'archivedAt',
  ],
  pos_order: ['id', 'number', 'tableId', 'locationId', 'status', 'covers', 'closedAt'],
  /** Never line notes (free text). */
  kitchen_ticket: ['id', 'orderId', 'sequence', 'kind', 'station', 'direct', 'status', 'lineCount'],
  dining_area: ['id', 'locationId', 'name', 'sortOrder'],
  /** `gross`: decimal string; `orderIds`, `checkNumbers`: string arrays. Never the cancel reason (free text). */
  /** `value`, `amount`: decimal strings; `reason` (free text) never appears. */
  pos_discount: ['id', 'orderId', 'orderLineId', 'kind', 'value', 'amount', 'voidsDiscountId'],
  pos_bill: [
    'id',
    'locationId',
    'kind',
    'shareCount',
    'orderIds',
    'checkNumbers',
    'gross',
    'cancelled',
  ],
  /** `resultCode`: the answer code, or `found` for a search; `printerCount`: printers a search found. */
  printer_command: [
    'id',
    'locationId',
    'kind',
    'printerId',
    'status',
    'resultCode',
    'printerCount',
  ],
  print_job: [
    'id',
    'locationId',
    'printerId',
    'kind',
    'orderId',
    'ticketId',
    'checkId',
    'status',
    'attempts',
    'lastCode',
  ],
  printer: [
    'id',
    'locationId',
    'name',
    'host',
    'port',
    'widthDots',
    'cutter',
    'imageMode',
    'enabled',
    'printsBills',
    'stations',
    'archivedAt',
  ],
  warehouse: [
    'id',
    'locationId',
    'name',
    'sortOrder',
    'suppliesStation',
    'isMain',
    'suppliesLocationIds',
    'archivedAt',
  ],
  /** `itemIds`: sorted, joined with commas; snapshots hold flat values only. */
  recipe: ['productId', 'lineCount', 'itemIds'],
  /** `minQuantity`: decimal string; `variantValues`: joined with ' / ' (ADR 0038). */
  stock_item: [
    'id',
    'name',
    'sku',
    'unit',
    'minQuantity',
    'parentItemId',
    'variantValues',
    'salePrice',
    'categoryId',
    'brand',
    'packCount',
    'packSize',
    'packUnit',
    'archivedAt',
  ],
  /** `factor`: decimal string, base units per unit. */
  unit_of_measure: ['id', 'name', 'symbol', 'baseUnit', 'factor', 'archivedAt'],
  /** `values`: joined with ', '. */
  variant_attribute: ['id', 'name', 'values', 'archivedAt'],
  /** `itemIds`: the components, sorted and joined with commas. */
  bom: ['itemId', 'outputQuantity', 'lineCount', 'itemIds'],
  /** Never `note` or `supplier` (free text). */
  stock_document: ['id', 'number', 'kind', 'warehouseId', 'toWarehouseId', 'reason', 'lineCount'],
  location: ['id', 'brandId', 'name', 'address', 'archivedAt', 'isWarehouseSite'],
  reservation_table_rule: ['tableId', 'bookingMode', 'minParty', 'maxParty'],
  reservation_combination: [
    'id',
    'locationId',
    'name',
    'tableIds',
    'minParty',
    'maxParty',
    'onlineBookable',
    'archivedAt',
  ],
  /** Never guest data or notes (free text). */
  reservation: [
    'id',
    'number',
    'locationId',
    'partySize',
    'startsAt',
    'endsAt',
    'status',
    'source',
    'tableIds',
    'overriddenRules',
    'sourceOrderId',
  ],
  /** Never the guest's name, email, phone or notes: only that and when they were erased. */
  reservation_guest: ['id', 'anonymisedAt'],
  /** Never contact details, address or notes (personal data; audit rows can't be erased). */
  customer: ['id', 'code', 'archivedAt'],
  /** Never the customer's details, the delivery address or notes. `total`: decimal string. */
  sales_order: [
    'id',
    'number',
    'status',
    'customerId',
    'locationId',
    'warehouseId',
    'lineCount',
    'total',
  ],
  /** Never the note (free text). */
  stock_request: [
    'id',
    'number',
    'transferNumber',
    'status',
    'locationId',
    'fromWarehouseId',
    'toWarehouseId',
    'lineCount',
    'driverUserId',
  ],
  /** Never the note or the reject reason (free text). */
  vendor_invoice: [
    'id',
    'number',
    'status',
    'warehouseId',
    'supplier',
    'invoiceNumber',
    'lineCount',
    'newItemCount',
    'total',
    'documentId',
  ],
} as const satisfies Record<AuditEntityType, readonly string[]>;
