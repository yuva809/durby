import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TeamListResponse, TeamMember } from '@durby/shared';
import { PASSWORD, randomIp, startAuthApp, type AuthTestKit } from './support/auth-app';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * Manage Staff (docs/platform/rbac.md → Manage Staff, ADR 0023): temporary passwords, invitations
 * with links, per-member permission changes, deactivation, granting rules and tenant isolation.
 */
describe('manage staff', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let ownerA: { id: string; token: string };
  let ownerB: { id: string; token: string };

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    [a, b] = await Promise.all([seed.org('Bistro A'), seed.org('Bistro B')]);
    [ownerA, ownerB] = await Promise.all([member(a, a.roles.owner), member(b, b.roles.owner)]);
  });

  afterAll(async () => {
    await kit.close();
  });

  async function member(org: SeededOrg, roleId: string) {
    const user = await kit.createUser();
    await seed.member(org.id, user.id, roleId);
    return { ...user, token: await seed.token(user.id, org.id) };
  }

  const api = (token: string) => ({
    list: async () =>
      (await request(kit.server).get('/api/v1/staff').auth(token, { type: 'bearer' }).expect(200))
        .body as TeamListResponse,
    post: (path: string, body: object = {}, key?: string) =>
      withIdempotencyKey(
        request(kit.server).post(`/api/v1/staff${path}`).auth(token, { type: 'bearer' }),
        key,
      ).send(body),
    patch: (id: string, body: object) =>
      withIdempotencyKey(
        request(kit.server).patch(`/api/v1/staff/${id}`).auth(token, { type: 'bearer' }),
      ).send(body),
    link: (invitationId: string) =>
      request(kit.server)
        .post(`/api/v1/invitations/${invitationId}/link`)
        .auth(token, { type: 'bearer' }),
  });

  const newEmail = () => `staff-${uuidv7()}@example.test`;
  const TEMP = 'temporary password 1';

  const preview = (link: string) =>
    request(kit.server)
      .post('/api/v1/invitations/preview')
      .set('X-Forwarded-For', randomIp())
      .send({ token: new URL(link).hash.replace('#token=', '') });

  it('creates an account with a temporary password and lists it with its profile', async () => {
    const email = newEmail();
    const created = await api(ownerA.token)
      .post('', {
        name: 'Ravi Kumar',
        email,
        phone: '+49 151 1234567',
        roleId: a.roles.waiter,
        temporaryPassword: TEMP,
      })
      .expect(201);
    expect(created.body).toMatchObject({ kind: 'created' });

    const list = await api(ownerA.token).list();
    const ravi = list.members.find((m) => m.email === email);
    expect(ravi).toMatchObject({
      name: 'Ravi Kumar',
      phone: '+49 151 1234567',
      role: { systemKey: 'waiter' },
      status: 'active',
      grants: [],
      denies: [],
      passwordChangePending: true,
      lastActiveAt: null,
    });

    // The staff member signs in with it (before verifying the email) and must change it first.
    const session = await kit.login(email, TEMP);
    expect(session.res.body).toMatchObject({
      passwordChangeRequired: true,
      activeOrganizationId: a.id,
    });
  });

  it('invites instead when the email already has an account, and never touches its password', async () => {
    const existing = await kit.createUser();
    const res = await api(ownerA.token)
      .post('', {
        name: 'Mina',
        email: existing.email,
        roleId: a.roles.cashier,
        temporaryPassword: TEMP,
      })
      .expect(201);
    expect(res.body).toMatchObject({ kind: 'invited', existingAccount: true });
    await kit.client().post('/login').send({ email: existing.email, password: TEMP }).expect(401);
    await kit.login(existing.email, PASSWORD);
  });

  it('gives a new link for an invitation and stops the old one', async () => {
    const email = newEmail();
    const res = await api(ownerA.token)
      .post('', { name: 'Arun', email, roleId: a.roles.staff })
      .expect(201);
    const { invitationId } = res.body as { invitationId: string };
    const first = (await api(ownerA.token).link(invitationId).expect(200)).body as { link: string };
    expect(first.link).toMatch(/\/accept-invite#token=/);
    await preview(first.link).expect(200);
    const second = (await api(ownerA.token).link(invitationId).expect(200)).body as {
      link: string;
    };
    expect(second.link).not.toBe(first.link);
    await preview(first.link).expect(400);
    await preview(second.link).expect(200);

    const list = await api(ownerA.token).list();
    expect(list.invitations.find((i) => i.invitationId === invitationId)).toMatchObject({
      name: 'Arun',
      email,
    });
  });

  it('applies per-member grants and denies on top of the role', async () => {
    const waiter = await member(a, a.roles.waiter);
    const list = await api(ownerA.token).list();
    const id = list.members.find((m) => m.userId === waiter.id)!.membershipId;
    const updated = (
      await api(ownerA.token)
        .patch(id, { grants: ['catalog.products.manage'], denies: ['pos.bills.print'] })
        .expect(200)
    ).body as TeamMember;
    expect(updated).toMatchObject({
      grants: ['catalog.products.manage'],
      denies: ['pos.bills.print'],
    });
    expect(updated.permissions).toContain('catalog.products.manage');
    expect(updated.permissions).not.toContain('pos.bills.print');

    const me = await request(kit.server)
      .get('/api/v1/auth/me')
      .auth(waiter.token, { type: 'bearer' })
      .expect(200);
    const permissions = (me.body as { activePermissions: string[] }).activePermissions;
    expect(permissions).toContain('catalog.products.manage');
    expect(permissions).not.toContain('pos.bills.print');
    expect((await api(ownerA.token).list()).stats.customPermissions).toBeGreaterThanOrEqual(1);

    // A grant the role already has, or a deny it lacks, is not stored.
    const noop = (
      await api(ownerA.token)
        .patch(id, { grants: ['pos.orders.read'], denies: ['platform.org.manage'] })
        .expect(200)
    ).body as TeamMember;
    expect(noop).toMatchObject({ grants: [], denies: [] });
  });

  it('never lets anyone grant a key they do not hold', async () => {
    const manager = await member(a, a.roles.manager);
    const res = await api(manager.token)
      .post('', {
        name: 'Lee',
        email: newEmail(),
        roleId: a.roles.waiter,
        grants: ['catalog.products.manage'],
        temporaryPassword: TEMP,
      })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'rbac.not_grantable' });
    await api(manager.token)
      .post('', { name: 'Lee', email: newEmail(), roleId: a.roles.waiter, grants: ['nope.key.x'] })
      .expect(400);
  });

  it('deactivates and reactivates a member, but never the last active Owner or yourself', async () => {
    const cashier = await member(a, a.roles.cashier);
    const id = (await api(ownerA.token).list()).members.find(
      (m) => m.userId === cashier.id,
    )!.membershipId;
    const labels = () =>
      request(kit.server).get('/api/v1/labels').auth(cashier.token, { type: 'bearer' });
    await labels().expect(200);
    const off = (await api(ownerA.token).post(`/${id}/deactivate`).expect(200)).body as TeamMember;
    expect(off.status).toBe('inactive');
    // Their open token stops working at once: revoked (401) or, failing that, no access (403).
    expect([401, 403]).toContain((await labels()).status);
    const on = (await api(ownerA.token).post(`/${id}/reactivate`).expect(200)).body as TeamMember;
    expect(on.status).toBe('active');
    await labels().expect(200);

    const ownerId = (await api(ownerA.token).list()).members.find(
      (m) => m.userId === ownerA.id,
    )!.membershipId;
    const self = await api(ownerA.token).post(`/${ownerId}/deactivate`).expect(403);
    expect(self.body).toMatchObject({ code: 'rbac.cannot_change_self' });

    // Owners can switch each other off while another active Owner remains (the database refuses
    // the last one: manage-staff-migration.int.spec.ts); an Admin can never touch an Owner.
    const second = await member(a, a.roles.owner);
    await api(second.token).post(`/${ownerId}/deactivate`).expect(200);
    const secondId = (await api(second.token).list()).members.find(
      (m) => m.userId === second.id,
    )!.membershipId;
    const third = await member(a, a.roles.owner);
    await api(third.token).post(`/${secondId}/deactivate`).expect(200);
    const thirdId = (await api(third.token).list()).members.find(
      (m) => m.userId === third.id,
    )!.membershipId;
    const fourth = await member(a, a.roles.admin);
    const last = await api(fourth.token).post(`/${thirdId}/deactivate`).expect(403);
    expect(last.body).toMatchObject({ code: 'rbac.not_grantable' });
    // Reactivate the first Owner for the other tests.
    await api(third.token).post(`/${ownerId}/reactivate`).expect(200);
  });

  it('keeps each organization to its own staff', async () => {
    const listA = await api(ownerA.token).list();
    const someone = listA.members.find((m) => m.userId !== ownerA.id)!;
    const listB = await api(ownerB.token).list();
    expect(listB.members.map((m) => m.membershipId)).not.toContain(someone.membershipId);
    const res = await api(ownerB.token).patch(someone.membershipId, { name: 'Hijack' }).expect(404);
    expect(res.body).toMatchObject({ code: 'rbac.member_not_found' });
    await api(ownerB.token).post(`/${someone.membershipId}/deactivate`).expect(404);
    const invitation = listA.invitations[0]!;
    await api(ownerB.token).link(invitation.invitationId).expect(404);
  });

  it('replays an idempotent create instead of adding the person twice', async () => {
    const email = newEmail();
    const key = uuidv7();
    const body = { name: 'Sam', email, roleId: a.roles.waiter, temporaryPassword: TEMP };
    const first = await api(ownerA.token).post('', body, key).expect(201);
    const again = await api(ownerA.token).post('', body, key).expect(201);
    expect(again.body).toEqual(first.body);
    const list = await api(ownerA.token).list();
    expect(list.members.filter((m) => m.email === email)).toHaveLength(1);
    expect(list.invitations.filter((i) => i.email === email)).toHaveLength(0);
  });
});
