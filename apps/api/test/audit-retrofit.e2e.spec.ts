import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditActor, AuditService } from '../src/platform/audit';
import { hashToken } from '../src/platform/auth/crypto';
import { TENANT_PRISMA, TenantContext, type TenantPrismaClient } from '../src/platform/tenancy';
import {
  cookie,
  PASSWORD,
  randomIp,
  startAuthApp,
  WEB_ORIGIN,
  type AuthTestKit,
} from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';

const NEW_PASSWORD = 'a brand new password';

/** Every audited flow writes its row in the change's transaction (docs/platform/audit.md). */
describe('audited actions', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let owner: { id: string; email: string; token: string };
  /** Values that must never appear in a snapshot; collected along the way. */
  const secrets: string[] = [PASSWORD, NEW_PASSWORD];

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    [a, b] = await Promise.all([seed.org('A'), seed.org('B')]);
    owner = await member(a, a.roles.owner);
  });

  afterAll(async () => {
    await kit.close();
  });

  async function member(org: SeededOrg, roleId: string) {
    const user = await kit.createUser();
    secrets.push(user.email);
    const membershipId = await seed.member(org.id, user.id, roleId);
    return { ...user, membershipId, token: await seed.token(user.id, org.id) };
  }

  /** Authenticated call with a fixed request id and client IP. */
  const call = (
    method: 'post' | 'patch' | 'delete',
    path: string,
    token: string,
    body?: object,
    meta = { requestId: `req-${uuidv7()}`, ip: randomIp() },
  ) => {
    const req = request(kit.server)
      [method](`/api/v1${path}`)
      .auth(token, { type: 'bearer' })
      .set('X-Request-Id', meta.requestId)
      .set('X-Forwarded-For', meta.ip);
    return body ? req.send(body) : req;
  };

  const rowsOf = (orgId: string, entityId?: string) =>
    seed.as(orgId, (db) =>
      db.auditLog.findMany({
        where: entityId === undefined ? {} : { entityId },
        orderBy: { id: 'asc' },
      }),
    );

  describe('roles', () => {
    it('create, update and delete each write one row with actor, snapshots, request id and IP', async () => {
      const meta = { requestId: 'req-role-create', ip: '203.0.113.7' };
      const created = await call(
        'post',
        '/roles',
        owner.token,
        { name: 'Shift lead', permissions: ['platform.users.read'] },
        meta,
      ).expect(201);
      const roleId = (created.body as { id: string }).id;
      await call('patch', `/roles/${roleId}`, owner.token, {
        permissions: ['platform.users.read', 'platform.roles.read'],
      }).expect(200);
      await call('delete', `/roles/${roleId}`, owner.token).expect(204);

      const rows = await rowsOf(a.id, roleId);
      expect(rows.map((r) => r.action)).toEqual([
        'platform.role.created',
        'platform.role.updated',
        'platform.role.deleted',
      ]);
      expect(rows[0]).toMatchObject({
        tenantId: a.id,
        actorType: 'user',
        actorUserId: owner.id,
        actorSystem: null,
        entityType: 'role',
        before: null,
        after: {
          id: roleId,
          name: 'Shift lead',
          systemKey: null,
          permissions: ['platform.users.read'],
        },
        requestId: 'req-role-create',
        ip: '203.0.113.7',
      });
      expect(rows[1]?.before).toMatchObject({ permissions: ['platform.users.read'] });
      expect(rows[1]?.after).toMatchObject({
        permissions: ['platform.roles.read', 'platform.users.read'],
      });
      expect(rows[2]).toMatchObject({ before: { id: roleId }, after: null });
    });

    it('a rejected change writes nothing', async () => {
      const before = (await rowsOf(a.id)).length;
      await call('patch', `/roles/${a.roles.admin}`, owner.token, { name: 'Boss' }).expect(409);
      await call('post', '/roles', owner.token, { name: 'X', permissions: ['nope.nope'] }).expect(
        400,
      );
      expect(await rowsOf(a.id)).toHaveLength(before);
    });
  });

  it('a row recorded in a transaction that rolls back is gone with it', async () => {
    const audit = kit.app.get(AuditService);
    const context = kit.app.get(TenantContext);
    const db = kit.app.get<TenantPrismaClient>(TENANT_PRISMA);
    const entityId = uuidv7();
    await expect(
      context.run({ tenantId: a.id, userId: owner.id }, () =>
        db.$transaction(async (tx) => {
          await audit.record(tx, {
            action: 'platform.role.deleted',
            actor: auditActor.user(owner.id),
            entityId,
          });
          throw new Error('change failed after the audit row');
        }),
      ),
    ).rejects.toThrow('change failed');
    expect(await rowsOf(a.id, entityId)).toEqual([]);
  });

  describe('members', () => {
    it('changing role and locations, then removing, write updated and removed', async () => {
      const staff = await member(a, a.roles.staff);
      await call('patch', `/members/${staff.membershipId}`, owner.token, {
        roleId: a.roles.manager,
        locationIds: [a.locations[1], a.locations[0]],
      }).expect(200);
      await call('delete', `/members/${staff.membershipId}`, owner.token).expect(204);

      const rows = await rowsOf(a.id, staff.membershipId);
      expect(rows.map((r) => [r.action, r.actorUserId])).toEqual([
        ['platform.membership.updated', owner.id],
        ['platform.membership.removed', owner.id],
      ]);
      expect(rows[0]?.before).toEqual({
        id: staff.membershipId,
        userId: staff.id,
        roleId: a.roles.staff,
        allLocations: true,
        locationIds: [],
      });
      expect(rows[0]?.after).toEqual({
        id: staff.membershipId,
        userId: staff.id,
        roleId: a.roles.manager,
        allLocations: false,
        locationIds: [...a.locations].sort(),
      });
      expect(rows[1]).toMatchObject({ before: { roleId: a.roles.manager }, after: null });
    });

    it('a change the actor may not make writes nothing', async () => {
      const soleOwnerOrg = await seed.org('Solo');
      const solo = await member(soleOwnerOrg, soleOwnerOrg.roles.owner);
      const admin = await member(soleOwnerOrg, soleOwnerOrg.roles.admin);
      await call('delete', `/members/${solo.membershipId}`, admin.token).expect(403);
      expect(await rowsOf(soleOwnerOrg.id)).toEqual([]);
    });
  });

  describe('invitations', () => {
    const inviteApi = (path: string, token: string, body?: object) =>
      call(body ? 'post' : 'delete', `/invitations${path}`, token, body);

    async function invite(email: string): Promise<{ id: string; token: string }> {
      const before = kit.mailer.to(email).length;
      const res = await inviteApi('', owner.token, { email, roleId: a.roles.staff }).expect(201);
      for (let i = 0; i < 100 && kit.mailer.to(email).length <= before; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const token =
        /accept-invite#token=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(
          kit.mailer.to(email).at(-1)?.text ?? '',
        )?.[1] ?? '';
      const secret = token.split('.')[1] ?? '';
      secrets.push(token, secret, hashToken(secret));
      return { id: (res.body as { id: string }).id, token };
    }

    it('create, replace, revoke and accept by a new user', async () => {
      const email = `invitee-${uuidv7()}@example.test`;
      secrets.push(email);
      const first = await invite(email);
      const second = await invite(email);
      await inviteApi(`/${second.id}`, owner.token).expect(204);
      const third = await invite(email);
      await request(kit.server)
        .post('/api/v1/invitations/accept')
        .set('X-Forwarded-For', '198.51.100.9')
        .set('X-Request-Id', 'req-accept')
        .send({ token: third.token, password: NEW_PASSWORD })
        .expect(200);
      const user = await kit.raw.user.findUniqueOrThrow({ where: { email } });

      const actions = async (id: string) => (await rowsOf(a.id, id)).map((r) => r.action);
      expect(await actions(first.id)).toEqual([
        'platform.invitation.created',
        'platform.invitation.revoked',
      ]);
      expect(await actions(second.id)).toEqual([
        'platform.invitation.created',
        'platform.invitation.revoked',
      ]);
      const accepted = await rowsOf(a.id, third.id);
      expect(accepted.map((r) => r.action)).toEqual([
        'platform.invitation.created',
        'platform.invitation.accepted',
      ]);
      expect(accepted[1]).toMatchObject({
        actorUserId: user.id,
        before: { acceptedAt: null, acceptedByUserId: null },
        after: { acceptedByUserId: user.id },
        requestId: 'req-accept',
        ip: '198.51.100.9',
      });
      const membership = (await rowsOf(a.id)).find(
        (r) => r.action === 'platform.membership.created' && r.actorUserId === user.id,
      );
      expect(membership).toMatchObject({
        after: { userId: user.id, roleId: a.roles.staff, allLocations: true },
        requestId: 'req-accept',
      });
    });

    it('accept by a signed-in user', async () => {
      const existing = await kit.createUser();
      secrets.push(existing.email);
      const { id, token } = await invite(existing.email);
      const access = await seed.token(existing.id, null);
      await request(kit.server)
        .post('/api/v1/invitations/accept-signed-in')
        .auth(access, { type: 'bearer' })
        .set('X-Forwarded-For', randomIp())
        .send({ token })
        .expect(200);
      const rows = await rowsOf(a.id, id);
      expect(rows.at(-1)).toMatchObject({
        action: 'platform.invitation.accepted',
        actorUserId: existing.id,
      });
    });
  });

  it('switching organization is audited in the target organization', async () => {
    const user = await kit.createUser();
    secrets.push(user.email);
    await seed.member(a.id, user.id, a.roles.staff);
    await seed.member(b.id, user.id, b.roles.staff);
    const client = kit.client('192.0.2.44');
    const login = await kit.login(user.email, PASSWORD, client);
    secrets.push(login.accessToken, login.refresh, hashToken(login.refresh));
    const from = (login.res.body as { activeOrganizationId: string }).activeOrganizationId;
    const to = from === a.id ? b.id : a.id;
    const sessionId = JSON.parse(
      Buffer.from(login.accessToken.split('.')[1] ?? '', 'base64url').toString(),
    ) as { sid: string };

    const res = await client
      .post('/switch-organization', WEB_ORIGIN)
      .auth(login.accessToken, { type: 'bearer' })
      .set('Cookie', cookie(login.refresh))
      .send({ organizationId: to })
      .expect(200);
    secrets.push((res.body as { accessToken: string }).accessToken);

    const rows = await rowsOf(to, sessionId.sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'platform.session.organization_switched',
      entityType: 'session',
      actorUserId: user.id,
      before: { organizationId: from },
      after: { organizationId: to, previousOrganizationId: from },
      ip: '192.0.2.44',
    });
    expect(await rowsOf(from, sessionId.sid)).toEqual([]);
  });

  // ADR 0008 §5. Runs last: scans every row the flows above wrote.
  it('no snapshot contains a password, token, hash or email address', async () => {
    const rows = [...(await rowsOf(a.id)), ...(await rowsOf(b.id))];
    expect(rows.length).toBeGreaterThan(10);
    const snapshots = JSON.stringify(rows.map((r) => [r.before, r.after]));
    for (const secret of secrets.filter(Boolean)) {
      expect(snapshots.includes(secret), `snapshot contains ${secret.slice(0, 6)}…`).toBe(false);
    }
    expect(snapshots).not.toMatch(/@example\.test/);
    const keys = rows.flatMap((r) => [
      ...Object.keys((r.before as object | null) ?? {}),
      ...Object.keys((r.after as object | null) ?? {}),
    ]);
    expect(keys.filter((k) => /hash|token|password|secret|email|link/i.test(k))).toEqual([]);
  });
});
