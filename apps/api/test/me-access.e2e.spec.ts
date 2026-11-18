import { PERMISSION_KEYS, systemRolePermissions } from '@durby/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookie, startAuthApp, type AuthTestKit } from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * activeRole / activePermissions in the session body and /auth/me (ADR 0007, amendment): only the
 * caller's own membership in the token's active organization, never another user's or org's.
 */
/** The Staff role's keys in registry order, as the api lists them. */
const STAFF_PERMISSIONS = [...systemRolePermissions('staff')];

describe('active role and permissions', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    [a, b] = await Promise.all([seed.org('Alpha'), seed.org('Beta')]);
  });

  afterAll(async () => {
    await kit.close();
  });

  const me = (token: string) =>
    request(kit.server).get('/api/v1/auth/me').auth(token, { type: 'bearer' }).expect(200);

  const access = (body: unknown) => {
    const { activeRole, activePermissions } = body as {
      activeRole: unknown;
      activePermissions: string[];
    };
    return { activeRole, activePermissions };
  };

  it('login and /auth/me carry the role and effective permissions of the active organization', async () => {
    const user = await kit.createUser();
    await seed.member(a.id, user.id, a.roles.owner);
    const session = await kit.login(user.email);
    const expected = {
      activeRole: { id: a.roles.owner, systemKey: 'owner', name: null },
      activePermissions: [...PERMISSION_KEYS],
    };
    expect(access(session.res.body)).toEqual(expected);
    expect(access((await me(session.accessToken)).body)).toEqual(expected);
  });

  it('follows organization switches: refresh and switch-organization return the new org', async () => {
    const user = await kit.createUser();
    await seed.member(a.id, user.id, a.roles.owner);
    await seed.member(b.id, user.id, b.roles.staff);
    const client = kit.client();
    const session = await kit.login(user.email, undefined, client);
    expect(session.res.body).toMatchObject({ activeOrganizationId: a.id });

    const switched = await client
      .post('/switch-organization')
      .set('Cookie', cookie(session.refresh))
      .auth(session.accessToken, { type: 'bearer' })
      .send({ organizationId: b.id })
      .expect(200);
    expect(access(switched.body)).toEqual({
      activeRole: { id: b.roles.staff, systemKey: 'staff', name: null },
      activePermissions: STAFF_PERMISSIONS,
    });
    const token = (switched.body as { accessToken: string }).accessToken;
    expect(access((await me(token)).body).activeRole).toMatchObject({ systemKey: 'staff' });
  });

  it("never returns another user's role in the same organization", async () => {
    const admin = await kit.createUser();
    const staff = await kit.createUser();
    await seed.member(a.id, admin.id, a.roles.admin);
    await seed.member(a.id, staff.id, a.roles.staff);
    const [adminMe, staffMe] = await Promise.all([
      me(await seed.token(admin.id, a.id)),
      me(await seed.token(staff.id, a.id)),
    ]);
    expect(access(adminMe.body).activeRole).toMatchObject({ id: a.roles.admin });
    expect(access(staffMe.body)).toEqual({
      activeRole: { id: a.roles.staff, systemKey: 'staff', name: null },
      activePermissions: STAFF_PERMISSIONS,
    });
  });

  it('never returns a role from another organization, even with a token claiming it', async () => {
    const user = await kit.createUser();
    await seed.member(a.id, user.id, a.roles.owner);
    // B has members (its owner), the user is not one of them.
    const ownerB = await kit.createUser();
    await seed.member(b.id, ownerB.id, b.roles.owner);
    const res = await me(await seed.token(user.id, b.id));
    expect(access(res.body)).toEqual({ activeRole: null, activePermissions: [] });
  });

  it('is empty without an active organization', async () => {
    const user = await kit.createUser();
    await seed.member(a.id, user.id, a.roles.owner);
    const res = await me(await seed.token(user.id, null));
    expect(access(res.body)).toEqual({ activeRole: null, activePermissions: [] });
  });

  it('shows custom role names and drops organization keys for location-limited members', async () => {
    const role = await seed.customRole(
      a.id,
      ['platform.users.read', 'platform.roles.read'],
      'Shift lead',
    );
    const everywhere = await kit.createUser();
    const scoped = await kit.createUser();
    await seed.member(a.id, everywhere.id, role);
    await seed.member(a.id, scoped.id, role, { locations: [a.locations[0]] });

    expect(access((await me(await seed.token(everywhere.id, a.id))).body)).toEqual({
      activeRole: { id: role, systemKey: null, name: 'Shift lead' },
      activePermissions: ['platform.users.read', 'platform.roles.read'],
    });
    expect(access((await me(await seed.token(scoped.id, a.id))).body)).toEqual({
      activeRole: { id: role, systemKey: null, name: 'Shift lead' },
      activePermissions: [],
    });
  });
});
