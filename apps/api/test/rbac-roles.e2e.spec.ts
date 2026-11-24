import { PERMISSION_KEYS } from '@durby/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { startAuthApp, type AuthTestKit } from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { withIdempotencyKey } from './support/idempotency';

describe('roles API', () => {
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
    post: (path: string, body: object) =>
      withIdempotencyKey(
        request(kit.server).post(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      ).send(body),
    patch: (path: string, body: object) =>
      withIdempotencyKey(
        request(kit.server).patch(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      ).send(body),
    delete: (path: string) =>
      withIdempotencyKey(
        request(kit.server).delete(`/api/v1${path}`).auth(token, { type: 'bearer' }),
      ),
  });

  async function tokenAs(org: SeededOrg, roleId: string) {
    const user = await kit.createUser();
    const membershipId = await seed.member(org.id, user.id, roleId);
    return { userId: user.id, membershipId, token: await seed.token(user.id, org.id) };
  }

  /** May manage roles and read users, nothing more. */
  const roleManagerRole = (org: SeededOrg) =>
    seed.customRole(org.id, [
      'platform.roles.manage',
      'platform.roles.read',
      'platform.users.read',
    ]);

  const name = () => `Role ${uuidv7()}`;

  it('lists system roles first with their effective permissions, then custom roles', async () => {
    const custom = await seed.customRole(b.id, ['platform.users.read'], 'Only in B');
    const { token } = await tokenAs(a, a.roles.manager);
    const res = await api(token).get('/roles').expect(200);
    const data = (
      res.body as { data: { id: string; systemKey: string | null; permissions: string[] }[] }
    ).data;
    expect(data.slice(0, 4).map((r) => r.systemKey)).toEqual([
      'owner',
      'admin',
      'manager',
      'staff',
    ]);
    expect(data[0]?.permissions).toEqual([...PERMISSION_KEYS]);
    expect(data[2]?.permissions).toEqual([
      'platform.org.read',
      'platform.users.read',
      'platform.users.invite',
      'platform.roles.read',
      'platform.settings.read',
      'platform.feedback.send',
      'catalog.products.read',
      'inventory.stock.read',
      'inventory.stock.receive',
      'inventory.stock.adjust',
      'inventory.stock.transfer',
      'inventory.stock.produce',
      'inventory.invoices.approve',
      'inventory.warehouses.create',
      'inventory.warehouses.edit',
      'inventory.warehouses.delete',
      'inventory.recipes.create',
      'inventory.recipes.edit',
      'inventory.recipes.delete',
      'inventory.costs.read',
      'inventory.prices.read',
      'pos.tables.read',
      'pos.tables.create',
      'pos.tables.edit',
      'pos.tables.delete',
      'pos.orders.read',
      'pos.orders.take',
      'pos.orders.void',
      'pos.orders.close',
      'pos.orders.discount',
      'pos.bills.print',
      'pos.bills.cancel',
      'pos.kitchen.use',
      'pos.bar.use',
      'reservations.bookings.read',
      'reservations.bookings.create',
      'reservations.bookings.edit',
      'reservations.bookings.delete',
      'reservations.waitlist.create',
      'reservations.waitlist.edit',
      'reservations.waitlist.delete',
      'reservations.setup.create',
      'reservations.setup.edit',
      'reservations.setup.delete',
      'orders.orders.read',
      'orders.orders.create',
      'orders.orders.edit',
      'orders.orders.delete',
      'orders.customers.read',
      'orders.customers.create',
      'orders.customers.edit',
      'orders.customers.delete',
      'orders.picking.use',
      'orders.delivery.use',
      'orders.delivery.assign',
      'orders.requests.read',
      'orders.requests.create',
      'orders.requests.receive',
      'reports.sales.read',
      'reports.reservations.read',
    ]);
    expect(data[3]?.permissions).toEqual([
      'platform.org.read',
      'platform.settings.read',
      'platform.feedback.send',
      'catalog.products.read',
      'inventory.stock.read',
      'inventory.prices.read',
      'pos.tables.read',
      'orders.orders.read',
      'orders.customers.read',
    ]);
    expect(data.map((r) => r.id)).not.toContain(custom);

    const staff = await tokenAs(a, a.roles.staff);
    await api(staff.token).get('/roles').expect(403);
  });

  // ADR 0045: the branch roles exist everywhere but show only with the orders module.
  it('lists Branch, Warehouse and Driver only where the organization has orders', async () => {
    const keys = async (org: SeededOrg) => {
      const { token } = await tokenAs(org, org.roles.owner);
      const res = await api(token).get('/roles').expect(200);
      return (res.body as { data: { systemKey: string | null }[] }).data.map((r) => r.systemKey);
    };
    const admin = kit.app.get(EntitlementsAdmin);
    const withOrders = await seed.org('With orders');
    await admin.setPlan(withOrders.id, 'inventory', 'cli.entitlements');
    expect(await keys(withOrders)).toEqual(
      expect.arrayContaining(['branch', 'warehouse', 'driver']),
    );
    const without = await seed.org('Without orders');
    await admin.setPlan(without.id, 'inventory', 'cli.entitlements');
    await admin.setOverride(without.id, 'orders', false, undefined, 'cli.entitlements');
    const shown = await keys(without);
    expect(shown).not.toContain('branch');
    expect(shown).not.toContain('driver');
    expect(shown).toContain('manager');
  });

  // ADR 0049: the till's roles show only with pos, the host's only with reservations.
  it('lists Waiter, Cashier, Kitchen, Bar and Host only where the organization has the till', async () => {
    const keys = async (org: SeededOrg) => {
      const { token } = await tokenAs(org, org.roles.owner);
      const res = await api(token).get('/roles').expect(200);
      return (res.body as { data: { systemKey: string | null }[] }).data.map((r) => r.systemKey);
    };
    const admin = kit.app.get(EntitlementsAdmin);
    const distributor = await seed.org('Distributor');
    await admin.setPlan(distributor.id, 'inventory', 'cli.entitlements');
    await admin.setOverride(distributor.id, 'pos', false, undefined, 'cli.entitlements');
    await admin.setOverride(distributor.id, 'reservations', false, undefined, 'cli.entitlements');
    const shown = await keys(distributor);
    for (const role of ['waiter', 'cashier', 'kitchen', 'bar', 'host']) {
      expect(shown).not.toContain(role);
    }
    expect(shown).toEqual(expect.arrayContaining(['owner', 'admin', 'manager', 'staff']));

    const restaurant = await seed.org('Restaurant');
    expect(await keys(restaurant)).toEqual(
      expect.arrayContaining(['waiter', 'cashier', 'kitchen', 'bar', 'host']),
    );
  });

  describe('POST /roles', () => {
    it('creates a custom role with registered keys', async () => {
      const { token } = await tokenAs(a, a.roles.admin);
      const roleName = name();
      const res = await api(token)
        .post('/roles', { name: ` ${roleName} `, permissions: ['platform.users.read'] })
        .expect(201);
      expect(res.body).toEqual({
        id: expect.any(String) as unknown,
        systemKey: null,
        name: roleName,
        permissions: ['platform.users.read'],
      });
      const dup = await api(token).post('/roles', { name: roleName, permissions: [] }).expect(409);
      expect(dup.body).toMatchObject({ code: 'rbac.role_name_taken' });
    });

    it('rejects keys that are not registered', async () => {
      const { token } = await tokenAs(a, a.roles.owner);
      const res = await api(token)
        .post('/roles', {
          name: name(),
          permissions: ['platform.users.read', 'platform.everything.do'],
        })
        .expect(400);
      expect(res.body).toMatchObject({
        code: 'rbac.permission_unknown',
        details: { keys: ['platform.everything.do'] },
      });
    });

    it('only grants keys the actor holds', async () => {
      const admin = await tokenAs(a, a.roles.admin);
      const res = await api(admin.token)
        .post('/roles', { name: name(), permissions: ['platform.org.manage'] })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'rbac.not_grantable' });

      const roleManager = await tokenAs(a, await roleManagerRole(a));
      await api(roleManager.token)
        .post('/roles', { name: name(), permissions: ['platform.users.edit'] })
        .expect(403);
      await api(roleManager.token)
        .post('/roles', { name: name(), permissions: ['platform.users.read'] })
        .expect(201);

      const owner = await tokenAs(a, a.roles.owner);
      await api(owner.token)
        .post('/roles', { name: name(), permissions: ['platform.org.manage'] })
        .expect(201);
    });

    it('needs platform.roles.manage', async () => {
      const { token } = await tokenAs(a, a.roles.manager);
      await api(token).post('/roles', { name: name(), permissions: [] }).expect(403);
    });
  });

  describe('PATCH /roles/:id', () => {
    it('renames and replaces the permissions of a custom role', async () => {
      const { token } = await tokenAs(a, a.roles.admin);
      const role = await seed.customRole(a.id, ['platform.users.read']);
      const roleName = name();
      const res = await api(token)
        .patch(`/roles/${role}`, { name: roleName, permissions: ['platform.audit.read'] })
        .expect(200);
      expect(res.body).toMatchObject({
        id: role,
        name: roleName,
        permissions: ['platform.audit.read'],
      });
    });

    it('applies the new permissions to members on their next request', async () => {
      const admin = await tokenAs(a, a.roles.admin);
      const role = await seed.customRole(a.id, []);
      const member = await tokenAs(a, role);
      await api(member.token).get('/roles').expect(403);
      await api(admin.token)
        .patch(`/roles/${role}`, { permissions: ['platform.roles.read'] })
        .expect(200);
      await api(member.token).get('/roles').expect(200);
    });

    it('cannot change system roles', async () => {
      const { token } = await tokenAs(a, a.roles.owner);
      const res = await api(token).patch(`/roles/${a.roles.staff}`, { name: 'Crew' }).expect(409);
      expect(res.body).toMatchObject({ code: 'rbac.system_role_immutable' });
    });

    it('cannot edit a role with keys the actor lacks, even to remove them', async () => {
      const roleManager = await tokenAs(a, await roleManagerRole(a));
      const powerful = await seed.customRole(a.id, [
        'platform.users.read',
        'platform.users.manage',
      ]);
      const res = await api(roleManager.token)
        .patch(`/roles/${powerful}`, { permissions: ['platform.users.read'] })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'rbac.not_grantable' });
      await api(roleManager.token).patch(`/roles/${powerful}`, { name: name() }).expect(403);
    });

    it("answers 404 for another organization's role and for malformed ids", async () => {
      const { token } = await tokenAs(a, a.roles.owner);
      const foreign = await seed.customRole(b.id, []);
      const res = await api(token).patch(`/roles/${foreign}`, { name: name() }).expect(404);
      expect(res.body).toMatchObject({ code: 'rbac.role_not_found' });
      await api(token).patch('/roles/42', { name: name() }).expect(404);
    });
  });

  describe('DELETE /roles/:id', () => {
    const invite = (
      roleId: string,
      state: { accepted?: string; revoked?: boolean; expired?: boolean },
    ) =>
      seed.as(a.id, async (db) => {
        const inviter = await kit.createUser();
        return db.invitation.create({
          data: {
            tenantId: a.id,
            email: `invitee-${uuidv7()}@example.test`,
            roleId,
            invitedByUserId: inviter.id,
            tokenHash: uuidv7(),
            expiresAt: new Date(Date.now() + (state.expired ? -1 : 1) * 3_600_000),
            acceptedAt: state.accepted ? new Date() : null,
            acceptedByUserId: state.accepted ?? null,
            revokedAt: state.revoked ? new Date() : null,
          },
        });
      });

    it('deletes an unused custom role, removing its closed invitations', async () => {
      const { token } = await tokenAs(a, a.roles.admin);
      const role = await seed.customRole(a.id, ['platform.users.read']);
      const acceptor = await kit.createUser();
      await invite(role, { accepted: acceptor.id });
      await invite(role, { revoked: true });
      await invite(role, { expired: true });
      await api(token).delete(`/roles/${role}`).expect(204);
      expect(await seed.as(a.id, (db) => db.role.count({ where: { id: role } }))).toBe(0);
      expect(await seed.as(a.id, (db) => db.invitation.count({ where: { roleId: role } }))).toBe(0);
    });

    it('refuses while a member or an open invitation uses the role', async () => {
      const { token } = await tokenAs(a, a.roles.admin);
      const used = await seed.customRole(a.id, []);
      await tokenAs(a, used);
      const res = await api(token).delete(`/roles/${used}`).expect(409);
      expect(res.body).toMatchObject({ code: 'rbac.role_in_use' });

      const invited = await seed.customRole(a.id, []);
      await invite(invited, {});
      await api(token).delete(`/roles/${invited}`).expect(409);
    });

    it('cannot delete system roles or roles with keys the actor lacks', async () => {
      const owner = await tokenAs(a, a.roles.owner);
      await api(owner.token).delete(`/roles/${a.roles.manager}`).expect(409);
      const admin = await tokenAs(a, a.roles.admin);
      const powerful = await seed.customRole(a.id, ['platform.org.manage']);
      await api(admin.token).delete(`/roles/${powerful}`).expect(403);
    });

    it("answers 404 for another organization's role", async () => {
      const { token } = await tokenAs(a, a.roles.owner);
      const foreign = await seed.customRole(b.id, []);
      await api(token).delete(`/roles/${foreign}`).expect(404);
      expect(await seed.as(b.id, (db) => db.role.count({ where: { id: foreign } }))).toBe(1);
    });
  });
});
