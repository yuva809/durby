import type { AuditAction, AuditLogEntry, AuditLogListResponse } from '@durby/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../src/platform/audit/audit-cursor';
import { startAuthApp, type AuthTestKit } from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';

describe('audit logs API', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let adminA: string;
  let adminB: string;
  const actorA = uuidv7();
  const roleInA = uuidv7();
  const roleInB = uuidv7();

  /** Rows written directly (the retrofit has its own tests); created in this order, oldest first. */
  async function write(
    org: SeededOrg,
    action: AuditAction,
    entityId: string,
    actorUserId?: string,
  ) {
    return seed.as(org.id, (db) =>
      db.auditLog.create({
        data: {
          tenantId: org.id,
          ...(actorUserId
            ? { actorType: 'user', actorUserId }
            : { actorType: 'system', actorSystem: 'cli.create_admin' }),
          action,
          entityType: action.split('.')[1] ?? '',
          entityId,
          after: { id: entityId },
        },
      }),
    );
  }

  async function tokenAs(org: SeededOrg, roleId: string) {
    const user = await kit.createUser();
    await seed.member(org.id, user.id, roleId);
    return seed.token(user.id, org.id);
  }

  const list = (token: string, query: Record<string, string | string[]> = {}) =>
    request(kit.server).get('/api/v1/audit-logs').query(query).auth(token, { type: 'bearer' });

  const ids = (res: request.Response) =>
    (res.body as AuditLogListResponse).data.map((e: AuditLogEntry) => e.id);

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    [a, b] = await Promise.all([seed.org('A'), seed.org('B')]);
    [adminA, adminB] = await Promise.all([tokenAs(a, a.roles.admin), tokenAs(b, b.roles.admin)]);
    for (let i = 0; i < 5; i++) await write(a, 'platform.role.updated', roleInA, actorA);
    await write(a, 'platform.organization.created', a.id);
    await write(b, 'platform.role.updated', roleInB, uuidv7());
  });

  afterAll(async () => {
    await kit.close();
  });

  it('returns the organization’s rows newest first, with the entry shape', async () => {
    const res = await list(adminA).expect(200);
    const body = res.body as AuditLogListResponse;
    expect(body.meta).toEqual({ nextCursor: null, limit: 50 });
    expect(body.data).toHaveLength(6);
    expect(ids(res)).toEqual([...ids(res)].sort().reverse());
    expect(body.data[0]).toMatchObject({
      actor: { type: 'system', key: 'cli.create_admin' },
      action: 'platform.organization.created',
      entityType: 'organization',
      entityId: a.id,
      before: null,
      after: { id: a.id },
    });
    expect(body.data[1]?.actor).toEqual({ type: 'user', userId: actorA });
  });

  it('pages with a cursor, without gaps or duplicates', async () => {
    const all = ids(await list(adminA).expect(200));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await list(adminA, {
        limit: '2',
        ...(cursor && { cursor }),
      }).expect(200);
      seen.push(...ids(res));
      cursor = (res.body as AuditLogListResponse).meta.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it('filters by action, entity, actor and time', async () => {
    expect(ids(await list(adminA, { action: 'platform.organization.created' }))).toHaveLength(1);
    expect(
      ids(
        await list(adminA, { action: ['platform.organization.created', 'platform.role.updated'] }),
      ),
    ).toHaveLength(6);
    expect(ids(await list(adminA, { entityType: 'role', entityId: roleInA }))).toHaveLength(5);
    expect(ids(await list(adminA, { actorUserId: actorA }))).toHaveLength(5);
    expect(ids(await list(adminA, { to: '2000-01-01T00:00:00Z' }))).toHaveLength(0);
    expect(ids(await list(adminA, { from: '2000-01-01T00:00:00Z' }))).toHaveLength(6);
  });

  it('rejects malformed queries and cursors', async () => {
    const bad = await list(adminA, { action: 'platform.role.renamed' }).expect(400);
    expect((bad.body as { code: string }).code).toBe('validation.failed');
    const cursor = await list(adminA, { cursor: 'not-a-cursor' }).expect(400);
    expect((cursor.body as { code: string }).code).toBe('audit.cursor_invalid');
  });

  it('needs platform.audit.read', async () => {
    const manager = await tokenAs(a, a.roles.manager);
    const res = await list(manager).expect(403);
    expect(res.body).toMatchObject({
      code: 'rbac.permission_denied',
      details: { permission: 'platform.audit.read' },
    });
  });

  describe('cross-tenant isolation', () => {
    it('B never sees A’s rows, and A never sees B’s', async () => {
      const inA = ids(await list(adminA).expect(200));
      const inB = ids(await list(adminB).expect(200));
      expect(inB).toHaveLength(1);
      expect(inA.filter((id) => inB.includes(id))).toEqual([]);
    });

    it('filtering by another tenant’s entity finds nothing', async () => {
      expect(ids(await list(adminB, { entityId: roleInA }).expect(200))).toEqual([]);
      expect(ids(await list(adminB, { actorUserId: actorA }).expect(200))).toEqual([]);
    });

    it('a cursor built from another tenant’s ids returns only own rows', async () => {
      const inA = ids(await list(adminA).expect(200));
      const inB = ids(await list(adminB).expect(200));
      // A cursor just above every id: would list A's rows if RLS didn't apply.
      const cursor = encodeCursor('ffffffff-ffff-7fff-bfff-ffffffffffff');
      expect(ids(await list(adminB, { cursor }).expect(200))).toEqual(inB);
      expect(ids(await list(adminB, { cursor: encodeCursor(inA[0] ?? '') }))).toEqual(
        inB.filter((id) => id < (inA[0] ?? '')),
      );
    });
  });
});
