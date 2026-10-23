import { describe, expect, it } from 'vitest';
import { auditLogEntrySchema, auditLogQuerySchema } from './audit';

const ID = '01a165d1-ff82-7d5e-8d25-abf61bd10091';

describe('audit log query', () => {
  it('defaults the limit and bounds it', () => {
    expect(auditLogQuerySchema.parse({}).limit).toBe(50);
    expect(auditLogQuerySchema.parse({ limit: '200' }).limit).toBe(200);
    expect(auditLogQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(auditLogQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('takes one or several registered actions', () => {
    expect(auditLogQuerySchema.parse({ action: 'platform.role.updated' }).action).toEqual([
      'platform.role.updated',
    ]);
    expect(
      auditLogQuerySchema.parse({ action: ['platform.role.updated', 'platform.role.deleted'] })
        .action,
    ).toHaveLength(2);
    expect(auditLogQuerySchema.safeParse({ action: 'platform.role.renamed' }).success).toBe(false);
  });

  it('validates entity type, ids and the time range', () => {
    expect(auditLogQuerySchema.safeParse({ entityType: 'user' }).success).toBe(false);
    expect(auditLogQuerySchema.safeParse({ entityId: 'nope' }).success).toBe(false);
    expect(
      auditLogQuerySchema.safeParse({
        from: '2026-10-23T10:00:00Z',
        to: '2026-10-23T09:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      auditLogQuerySchema.safeParse({
        entityType: 'role',
        entityId: ID,
        actorUserId: ID,
        from: '2026-10-23T09:00:00+02:00',
        to: '2026-10-23T10:00:00Z',
      }).success,
    ).toBe(true);
  });
});

describe('audit log entry', () => {
  const entry = {
    id: ID,
    action: 'platform.role.updated',
    entityType: 'role',
    entityId: ID,
    before: { name: 'Old' },
    after: { name: 'New' },
    requestId: null,
    ip: null,
    createdAt: '2026-10-23T09:00:00.000Z',
  };

  it('has a user or a registered system actor', () => {
    expect(
      auditLogEntrySchema.safeParse({ ...entry, actor: { type: 'user', userId: ID } }).success,
    ).toBe(true);
    expect(
      auditLogEntrySchema.safeParse({
        ...entry,
        actor: { type: 'system', key: 'cli.create_admin' },
      }).success,
    ).toBe(true);
    expect(
      auditLogEntrySchema.safeParse({ ...entry, actor: { type: 'system', key: 'cron' } }).success,
    ).toBe(false);
  });
});
