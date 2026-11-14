import { z } from 'zod';
import { AUDIT_ACTION_KEYS, AUDIT_ENTITY_TYPES, AUDIT_SYSTEM_ACTOR_KEYS } from '../audit';

/** Query and response of GET /api/v1/audit-logs (docs/platform/audit.md → Endpoint). */

export const AUDIT_PAGE_DEFAULT_LIMIT = 50;
export const AUDIT_PAGE_MAX_LIMIT = 200;

/** The modules actions belong to: an action key's first segment (`inventory.unit.created` → `inventory`). */
export const AUDIT_MODULES: readonly string[] = [
  ...new Set(AUDIT_ACTION_KEYS.map((action) => action.split('.')[0]!)),
];

/** An action's module. */
export const auditModuleOf = (action: string): string => action.split('.')[0] ?? '';

/** `?action=a` arrives as a string, `?action=a&action=b` as an array. */
const oneOrMany = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? [value] : value),
    z.array(item).min(1).max(50),
  );

export const auditLogQuerySchema = z
  .object({
    action: oneOrMany(z.enum(AUDIT_ACTION_KEYS)).optional(),
    entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
    entityId: z.uuid().optional(),
    actorUserId: z.uuid().optional(),
    /** Only actions of this module (the action key's first segment), e.g. `inventory`. */
    module: z
      .string()
      .refine((value) => AUDIT_MODULES.includes(value), { message: 'Unknown module' })
      .optional(),
    /** Only entries whose record is at this location (`locationId` in the before or after snapshot). */
    locationId: z.uuid().optional(),
    /** Inclusive lower bound on created_at. */
    from: z.iso.datetime({ offset: true }).optional(),
    /** Exclusive upper bound on created_at. */
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AUDIT_PAGE_MAX_LIMIT)
      .default(AUDIT_PAGE_DEFAULT_LIMIT),
    /** Opaque; `meta.nextCursor` of the previous page. The api rejects malformed ones (400 audit.cursor_invalid). */
    cursor: z.string().min(1).max(100).optional(),
  })
  .refine(
    (q) => q.from === undefined || q.to === undefined || Date.parse(q.from) < Date.parse(q.to),
    {
      message: '`from` must be before `to`',
      path: ['from'],
    },
  );

export const auditActorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: z.uuid() }),
  z.object({ type: z.literal('system'), key: z.enum(AUDIT_SYSTEM_ACTOR_KEYS) }),
]);

/** The actor as the list shows it: user actors carry their email (display only). */
export const auditLogActorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    userId: z.uuid(),
    /**
     * Looked up when the page is read, never stored in audit rows. null if the user no longer
     * exists, or from an api before 1.10 (d).
     */
    email: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal('system'), key: z.enum(AUDIT_SYSTEM_ACTOR_KEYS) }),
]);

/** Allow-listed snapshot (ADR 0008 §5); null before a create and after a delete. */
const snapshot = z.record(z.string(), z.unknown()).nullable();

export const auditLogEntrySchema = z.object({
  id: z.uuid(),
  actor: auditLogActorSchema,
  action: z.enum(AUDIT_ACTION_KEYS),
  entityType: z.enum(AUDIT_ENTITY_TYPES),
  entityId: z.uuid(),
  before: snapshot,
  after: snapshot,
  /** null outside an HTTP request (CLI, jobs). */
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const auditLogListResponseSchema = z.object({
  data: z.array(auditLogEntrySchema),
  meta: z.object({
    /** null on the last page. */
    nextCursor: z.string().nullable(),
    limit: z.number().int(),
  }),
});

/** Stable error codes of the audit endpoints; the web app shows the matching label. */
export const AUDIT_ERROR_CODES = ['audit.cursor_invalid'] as const;

export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditLogActor = z.infer<typeof auditLogActorSchema>;
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;
