import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookie, PASSWORD, startAuthApp, type AuthTestKit } from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * Temporary passwords and deactivation (ADR 0023 §3, §6): a session of an account created with a
 * temporary password can only change it (plus /auth/me and logout); a deactivated member has no
 * access and can't switch into the organization.
 */
describe('temporary passwords and deactivation', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let org: SeededOrg;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    org = await seed.org('Alpha');
  });

  afterAll(async () => {
    await kit.close();
  });

  /** An account as POST /staff creates it: temporary password, vouched, email not verified. */
  async function temporaryAccount() {
    const user = await kit.createUser({ verified: false });
    await kit.raw.user.update({
      where: { id: user.id },
      data: { mustChangePassword: true, vouchedByOrganizationId: org.id },
    });
    await seed.member(org.id, user.id, org.roles.manager);
    return user;
  }

  const members = (token: string) =>
    request(kit.server).get('/api/v1/members').auth(token, { type: 'bearer' });

  it('lets a vouched account sign in before verifying, but only to change its password', async () => {
    const user = await temporaryAccount();
    const session = await kit.login(user.email);
    expect(session.res.body).toMatchObject({
      passwordChangeRequired: true,
      activeOrganizationId: org.id,
    });

    const blocked = await members(session.accessToken).expect(403);
    expect(blocked.body).toMatchObject({ code: 'auth.password_change_required' });
    const me = await request(kit.server)
      .get('/api/v1/auth/me')
      .auth(session.accessToken, { type: 'bearer' })
      .expect(200);
    expect(me.body).toMatchObject({ passwordChangeRequired: true });

    const client = kit.client();
    const wrong = await client
      .post('/password/change')
      .auth(session.accessToken, { type: 'bearer' })
      .send({ currentPassword: 'not it at all', newPassword: 'a brand new password' })
      .expect(401);
    expect(wrong.body).toMatchObject({ code: 'auth.invalid_credentials' });

    const changed = await client
      .post('/password/change')
      .auth(session.accessToken, { type: 'bearer' })
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' })
      .expect(200);
    expect(changed.body).toMatchObject({
      passwordChangeRequired: false,
      activeOrganizationId: org.id,
    });
    await members((changed.body as { accessToken: string }).accessToken).expect(200);

    // The old session is over; the new password signs in, without the flag.
    await kit.client().post('/refresh').set('Cookie', cookie(session.refresh)).expect(401);
    const again = await kit.login(user.email, 'a brand new password');
    expect(again.res.body).toMatchObject({ passwordChangeRequired: false });
  });

  it('still refuses unverified accounts nobody vouched for', async () => {
    const user = await kit.createUser({ verified: false });
    const res = await kit
      .client()
      .post('/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'auth.email_not_verified' });
  });

  it('gives a deactivated member no access and no way back in by switching', async () => {
    const other = await seed.org('Beta');
    const user = await kit.createUser();
    const membershipId = await seed.member(org.id, user.id, org.roles.admin);
    await seed.member(other.id, user.id, other.roles.staff);
    const token = await seed.token(user.id, org.id);
    await members(token).expect(200);

    await seed.as(org.id, (db) =>
      db.membership.update({ where: { id: membershipId }, data: { deactivatedAt: new Date() } }),
    );
    const denied = await members(token).expect(403);
    expect(denied.body).toMatchObject({ code: 'rbac.permission_denied' });

    const session = await kit.login(user.email);
    expect(session.res.body).toMatchObject({
      organizations: [{ id: other.id }],
      activeOrganizationId: other.id,
    });
    const switched = await kit
      .client()
      .post('/switch-organization')
      .set('Cookie', cookie(session.refresh))
      .auth(session.accessToken, { type: 'bearer' })
      .send({ organizationId: org.id })
      .expect(403);
    expect(switched.body).toMatchObject({ code: 'auth.not_a_member' });
  });
});
