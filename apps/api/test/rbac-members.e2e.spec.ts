import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookie, startAuthApp, type AuthTestKit } from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { withIdempotencyKey } from './support/idempotency';

describe('members API', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    [a, b] = await Promise.all([seed.org('A'), seed.org('B')]);
  });

  afterAll(async () => {
    await kit.close();
  });

  const api = (token: string) => ({
    get: (path: string) =>
      request(kit.server).get(`/api/v1${path}`).auth(token, { type: 'bearer' }),
    patch: (path: string, body: object) =>
      withIdempotencyKey(
        request(kit.server).patch(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      ).send(body),
    delete: (path: string) =>
      withIdempotencyKey(
        request(kit.server).delete(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      ),
  });

  /** A user with a membership in `org` and an access token for it. */
  async function member(org: SeededOrg, roleId: string, opts?: { locations?: string[] }) {
    const user = await kit.createUser();
    const membershipId = await seed.member(org.id, user.id, roleId, opts);
    return { ...user, membershipId, token: await seed.token(user.id, org.id) };
  }

  /** A custom role that may manage members but holds nothing else of note. */
  // settings.read too: every system role holds it, and you can only manage roles within your own
  // keys (ADR 0010 §6).
  // Holds Staff's keys, so it may manage Staff members (granting needs every key of the role).
  const userManagerRole = (org: SeededOrg) =>
    seed.customRole(org.id, [
      'platform.users.read',
      'platform.users.manage',
      'platform.settings.read',
      'catalog.products.read',
      'pos.tables.read',
      'inventory.stock.read',
    ]);

  describe('GET /members', () => {
    it('lists members with email, role and locations; needs platform.users.read', async () => {
      const owner = await member(a, a.roles.owner);
      const scoped = await member(a, a.roles.staff, { locations: [a.locations[0]] });
      const res = await api(owner.token).get('/members').expect(200);
      const data = (res.body as { data: { id: string }[] }).data;
      expect(data.find((m) => m.id === scoped.membershipId)).toEqual({
        id: scoped.membershipId,
        userId: scoped.id,
        email: scoped.email,
        role: { id: a.roles.staff, systemKey: 'staff', name: null },
        allLocations: false,
        locationIds: [a.locations[0]],
      });
      // RLS: B's members are not listed.
      const other = await member(b, b.roles.staff);
      expect(data.map((m) => m.id)).not.toContain(other.membershipId);

      await api(scoped.token).get('/members').expect(403);
    });
  });

  describe('PATCH /members/:id', () => {
    it('changes role and locations of a member the actor may manage', async () => {
      const admin = await member(a, a.roles.admin);
      const staff = await member(a, a.roles.staff);
      const res = await api(admin.token)
        .patch(`/members/${staff.membershipId}`, {
          roleId: a.roles.manager,
          locationIds: [a.locations[1]],
        })
        .expect(200);
      expect(res.body).toMatchObject({
        role: { id: a.roles.manager, systemKey: 'manager' },
        allLocations: false,
        locationIds: [a.locations[1]],
      });
      const back = await api(admin.token)
        .patch(`/members/${staff.membershipId}`, { locationIds: null })
        .expect(200);
      expect(back.body).toMatchObject({ allLocations: true, locationIds: [] });
    });

    it('a manager of members cannot change or remove a member with more permissions', async () => {
      const manager = await member(a, await userManagerRole(a));
      const admin = await member(a, a.roles.admin);
      const staff = await member(a, a.roles.staff);

      const denied = await api(manager.token)
        .patch(`/members/${admin.membershipId}`, { roleId: a.roles.staff })
        .expect(403);
      expect(denied.body).toMatchObject({ code: 'rbac.not_grantable' });
      await api(manager.token).delete(`/members/${admin.membershipId}`).expect(403);

      // Nor grant a role above their own.
      const up = await api(manager.token)
        .patch(`/members/${staff.membershipId}`, { roleId: a.roles.admin })
        .expect(403);
      expect(up.body).toMatchObject({ code: 'rbac.not_grantable' });
      // A role within their own keys is fine.
      await api(manager.token)
        .patch(`/members/${staff.membershipId}`, { locationIds: [a.locations[0]] })
        .expect(200);
    });

    it('only an owner can change, remove or assign an owner', async () => {
      const admin = await member(a, a.roles.admin);
      const owner = await member(a, a.roles.owner);
      const staff = await member(a, a.roles.staff);

      await api(admin.token)
        .patch(`/members/${owner.membershipId}`, { roleId: a.roles.staff })
        .expect(403);
      await api(admin.token).delete(`/members/${owner.membershipId}`).expect(403);
      const assign = await api(admin.token)
        .patch(`/members/${staff.membershipId}`, { roleId: a.roles.owner })
        .expect(403);
      expect(assign.body).toMatchObject({ code: 'rbac.not_grantable' });

      await api(owner.token)
        .patch(`/members/${staff.membershipId}`, { roleId: a.roles.owner })
        .expect(200);
      // Two owners now: one can demote the other.
      await api(owner.token)
        .patch(`/members/${staff.membershipId}`, { roleId: a.roles.admin })
        .expect(200);
    });

    it('nobody can change or remove their own membership', async () => {
      const owner = await member(a, a.roles.owner);
      const res = await api(owner.token)
        .patch(`/members/${owner.membershipId}`, { roleId: a.roles.staff })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'rbac.cannot_change_self' });
      await api(owner.token)
        .patch(`/members/${owner.membershipId}`, { locationIds: [a.locations[0]] })
        .expect(403);
      const del = await api(owner.token).delete(`/members/${owner.membershipId}`).expect(403);
      expect(del.body).toMatchObject({ code: 'rbac.cannot_change_self' });
    });

    it('an owner always covers all locations', async () => {
      const owner = await member(a, a.roles.owner);
      const other = await member(a, a.roles.owner);
      const res = await api(owner.token)
        .patch(`/members/${other.membershipId}`, { locationIds: [a.locations[0]] })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'rbac.owner_all_locations' });
      const scoped = await member(a, a.roles.staff, { locations: [a.locations[0]] });
      await api(owner.token)
        .patch(`/members/${scoped.membershipId}`, { roleId: a.roles.owner })
        .expect(409);
    });

    it("rejects another organization's member, role and location ids", async () => {
      const owner = await member(a, a.roles.owner);
      const staff = await member(a, a.roles.staff);
      const foreign = await member(b, b.roles.staff);

      const m = await api(owner.token)
        .patch(`/members/${foreign.membershipId}`, { roleId: a.roles.staff })
        .expect(404);
      expect(m.body).toMatchObject({ code: 'rbac.member_not_found' });
      await api(owner.token).delete(`/members/${foreign.membershipId}`).expect(404);
      const r = await api(owner.token)
        .patch(`/members/${staff.membershipId}`, { roleId: b.roles.staff })
        .expect(404);
      expect(r.body).toMatchObject({ code: 'rbac.role_not_found' });
      const l = await api(owner.token)
        .patch(`/members/${staff.membershipId}`, { locationIds: [b.locations[0]] })
        .expect(404);
      expect(l.body).toMatchObject({ code: 'rbac.location_not_found' });
      await api(owner.token).patch('/members/not-a-uuid', { locationIds: null }).expect(404);
    });

    it('validates the body', async () => {
      const owner = await member(a, a.roles.owner);
      const staff = await member(a, a.roles.staff);
      const res = await api(owner.token).patch(`/members/${staff.membershipId}`, {}).expect(400);
      expect(res.body).toMatchObject({ code: 'validation.failed' });
    });
  });

  describe('last owner', () => {
    it('two owners demoting each other at once: exactly one succeeds', async () => {
      const org = await seed.org('Race');
      const one = await member(org, org.roles.owner);
      const two = await member(org, org.roles.owner);
      const results = await Promise.all([
        api(one.token).patch(`/members/${two.membershipId}`, { roleId: org.roles.staff }),
        api(two.token).patch(`/members/${one.membershipId}`, { roleId: org.roles.staff }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body).toMatchObject({
        code: 'rbac.last_owner',
      });
      const owners = await seed.as(org.id, (db) =>
        db.membership.count({ where: { roleId: org.roles.owner } }),
      );
      expect(owners).toBe(1);
    });

    it('two owners removing each other at once: exactly one succeeds', async () => {
      const org = await seed.org('Race 2');
      const one = await member(org, org.roles.owner);
      const two = await member(org, org.roles.owner);
      const results = await Promise.all([
        api(one.token).delete(`/members/${two.membershipId}`),
        api(two.token).delete(`/members/${one.membershipId}`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    });

    it('the database refuses to leave an organization without an owner (trigger backstop)', async () => {
      const org = await seed.org('Backstop');
      const only = await member(org, org.roles.owner);
      await expect(
        seed.as(org.id, (db) =>
          db.membership.update({
            where: { id: only.membershipId },
            data: { roleId: org.roles.staff },
          }),
        ),
      ).rejects.toThrow(/would have no owner/);
      await expect(
        seed.as(org.id, (db) => db.membership.delete({ where: { id: only.membershipId } })),
      ).rejects.toThrow(/would have no owner/);
    });

    it('an ownership transfer inside one transaction works', async () => {
      const org = await seed.org('Transfer');
      const from = await member(org, org.roles.owner);
      const to = await member(org, org.roles.staff);
      await seed.as(org.id, (db) =>
        db.$transaction(async (tx) => {
          await tx.membership.update({
            where: { id: to.membershipId },
            data: { roleId: org.roles.owner },
          });
          await tx.membership.update({
            where: { id: from.membershipId },
            data: { roleId: org.roles.staff },
          });
        }),
      );
      const owners = await seed.as(org.id, (db) =>
        db.membership.findMany({ where: { roleId: org.roles.owner }, select: { id: true } }),
      );
      expect(owners).toEqual([{ id: to.membershipId }]);
    });
  });

  describe('DELETE /members/:id', () => {
    it('ends access at once: the old token is rejected and refresh drops the organization', async () => {
      const owner = await member(a, a.roles.owner);
      const target = await member(a, a.roles.admin);
      const client = kit.client();
      const session = await kit.login(target.email, undefined, client);
      expect(session.res.body).toMatchObject({ activeOrganizationId: a.id });
      await api(session.accessToken).get('/members').expect(200);

      // The clock stands still: login and removal fall in the same second, and the token is
      // still rejected (the membership marker compares iat <= marker).
      await api(owner.token).delete(`/members/${target.membershipId}`).expect(204);
      await api(session.accessToken).get('/members').expect(401);

      // Even user-level routes: the token carries an organization the user no longer belongs to.
      await request(kit.server)
        .get('/api/v1/auth/me')
        .auth(session.accessToken, { type: 'bearer' })
        .expect(401);
      const refreshed = await client
        .post('/refresh')
        .set('Cookie', cookie(session.refresh))
        .expect(200);
      expect(refreshed.body).toMatchObject({ activeOrganizationId: null, organizations: [] });
      const fresh = (refreshed.body as { accessToken: string }).accessToken;
      await request(kit.server).get('/api/v1/auth/me').auth(fresh, { type: 'bearer' }).expect(200);
    });

    it("a removal in one organization leaves the user's tokens for another organization alone", async () => {
      const ownerA = await member(a, a.roles.owner);
      const user = await kit.createUser();
      const inA = await seed.member(a.id, user.id, a.roles.staff);
      await seed.member(b.id, user.id, b.roles.admin);
      const tokenB = await seed.token(user.id, b.id);

      await api(ownerA.token).delete(`/members/${inA}`).expect(204);
      await api(tokenB).get('/members').expect(200);
    });
  });
});
