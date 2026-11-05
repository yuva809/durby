import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/platform/auth/password-hasher';
import { PASSWORD, randomIp, startAuthApp, WEB_ORIGIN, type AuthTestKit } from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';
import { withIdempotencyKey } from './support/idempotency';

const NEW_PASSWORD = 'a brand new password';

describe('invitations', () => {
  const logs: string[] = [];
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;
  let ownerA: { id: string; token: string };

  beforeAll(async () => {
    kit = await startAuthApp({ logs });
    seed = new RbacSeed(kit.app);
  });

  // Each test gets its own organizations and Owner session, so no test depends on what another
  // left in the invitation list or did to a shared token.
  beforeEach(async () => {
    [a, b] = await Promise.all([seed.org('Bistro A'), seed.org('Bistro B')]);
    ownerA = await member(a, a.roles.owner);
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
    get: (path: string) =>
      request(kit.server).get(`/api/v1/invitations${path}`).auth(token, { type: 'bearer' }),
    post: (path: string, body: object) =>
      withIdempotencyKey(
        request(kit.server).post(`/api/v1/invitations${path}`).auth(token, { type: 'bearer' }),
      ).send(body),
    delete: (path: string) =>
      withIdempotencyKey(
        request(kit.server).delete(`/api/v1/invitations${path}`).auth(token, { type: 'bearer' }),
      ),
  });

  /** Public endpoints, each test with its own client IP (rate limits are per IP). */
  const open = (ip = randomIp()) => ({
    preview: (token: string) =>
      request(kit.server)
        .post('/api/v1/invitations/preview')
        .set('X-Forwarded-For', ip)
        .send({ token }),
    accept: (token: string, password = NEW_PASSWORD) =>
      request(kit.server)
        .post('/api/v1/invitations/accept')
        .set('X-Forwarded-For', ip)
        .send({ token, password, locale: 'de' }),
  });

  const newEmail = () => `invitee-${uuidv7()}@example.test`;

  /** Invites and returns the token from the mail. */
  async function invite(
    email: string,
    body: { roleId?: string; locationIds?: string[] | null } = {},
    token = ownerA.token,
  ): Promise<string> {
    const before = kit.mailer.to(email).length;
    await api(token)
      .post('', { email, roleId: body.roleId ?? a.roles.staff, locationIds: body.locationIds })
      .expect(201);
    return tokenFromMail(email, before);
  }

  async function tokenFromMail(email: string, before = 0): Promise<string> {
    for (let i = 0; i < 100 && kit.mailer.to(email).length <= before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const mail = kit.mailer.to(email).at(-1);
    const match = /\/accept-invite#token=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(mail?.text ?? '');
    expect(match, 'invitation link in mail').not.toBeNull();
    expect(mail?.text).toContain(`${WEB_ORIGIN}/accept-invite#token=`);
    return match?.[1] ?? '';
  }

  const roleOf = (orgId: string, userId: string) =>
    seed.as(orgId, (db) =>
      db.membership.findUnique({
        where: { tenantId_userId: { tenantId: orgId, userId } },
        select: {
          role: { select: { systemKey: true } },
          allLocations: true,
          locations: { select: { locationId: true } },
        },
      }),
    );

  describe('POST /invitations', () => {
    it('answers the same and sends the same mail whether or not the email has an account', async () => {
      const existing = await kit.createUser();
      const fresh = newEmail();
      const responses = [];
      for (const email of [existing.email, fresh]) {
        const res = await api(ownerA.token).post('', { email, roleId: a.roles.staff }).expect(201);
        responses.push(res.body as Record<string, unknown>);
      }
      const shape = (body: Record<string, unknown>) => ({
        ...body,
        id: 'x',
        email: 'x',
        createdAt: 'x',
        expiresAt: 'x',
      });
      expect(shape(responses[0] ?? {})).toEqual(shape(responses[1] ?? {}));
      expect(responses[1]).toMatchObject({
        email: fresh,
        role: { id: a.roles.staff, systemKey: 'staff', name: null },
        allLocations: true,
        locationIds: [],
      });

      await tokenFromMail(existing.email);
      await tokenFromMail(fresh);
      const text = (email: string) =>
        (kit.mailer.to(email).at(-1)?.text ?? '').replace(/#token=\S+/, '#token=T');
      expect(text(existing.email)).toBe(text(fresh));
      expect(kit.mailer.to(fresh).at(-1)?.subject).toContain('Bistro A');
    });

    it('applies the granting rules', async () => {
      const manager = await member(a, a.roles.manager);
      await api(manager.token).post('', { email: newEmail(), roleId: a.roles.staff }).expect(201);
      const up = await api(manager.token)
        .post('', { email: newEmail(), roleId: a.roles.admin })
        .expect(403);
      expect(up.body).toMatchObject({ code: 'rbac.not_grantable' });
      const admin = await member(a, a.roles.admin);
      await api(admin.token).post('', { email: newEmail(), roleId: a.roles.owner }).expect(403);
      const staff = await member(a, a.roles.staff);
      await api(staff.token).post('', { email: newEmail(), roleId: a.roles.staff }).expect(403);
    });

    it('rejects members, owners limited to locations, and ids of another organization', async () => {
      const existing = await member(a, a.roles.staff);
      const res = await api(ownerA.token)
        .post('', { email: existing.email.toUpperCase(), roleId: a.roles.staff })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'invitations.already_member' });

      const owner = await api(ownerA.token)
        .post('', { email: newEmail(), roleId: a.roles.owner, locationIds: [a.locations[0]] })
        .expect(409);
      expect(owner.body).toMatchObject({ code: 'rbac.owner_all_locations' });

      const role = await api(ownerA.token)
        .post('', { email: newEmail(), roleId: b.roles.staff })
        .expect(404);
      expect(role.body).toMatchObject({ code: 'rbac.role_not_found' });
      const location = await api(ownerA.token)
        .post('', { email: newEmail(), roleId: a.roles.staff, locationIds: [b.locations[0]] })
        .expect(404);
      expect(location.body).toMatchObject({ code: 'rbac.location_not_found' });
    });

    it('a new invitation for the same email revokes the previous one', async () => {
      const email = newEmail();
      const first = await invite(email);
      const second = await invite(email);
      await open().preview(first).expect(400);
      await open().preview(second).expect(200);
    });
  });

  describe('GET and DELETE /invitations', () => {
    it('lists open invitations and revokes them', async () => {
      const email = newEmail();
      const token = await invite(email, { locationIds: [a.locations[1]] });
      const list = await api(ownerA.token).get('').expect(200);
      const item = (list.body as { data: { id: string; email: string }[] }).data.find(
        (i) => i.email === email,
      );
      expect(item).toMatchObject({ allLocations: false, locationIds: [a.locations[1]] });

      await api(ownerA.token)
        .delete(`/${item?.id ?? ''}`)
        .expect(204);
      await api(ownerA.token)
        .delete(`/${item?.id ?? ''}`)
        .expect(404);
      await open().preview(token).expect(400);
    });

    it("never shows or revokes another organization's invitations", async () => {
      const ownerB = await member(b, b.roles.owner);
      const email = newEmail();
      await invite(email, { roleId: b.roles.staff }, ownerB.token);
      const listB = await api(ownerB.token).get('').expect(200);
      const id = (listB.body as { data: { id: string; email: string }[] }).data.find(
        (i) => i.email === email,
      )?.id;
      const listA = await api(ownerA.token).get('').expect(200);
      expect((listA.body as { data: { id: string }[] }).data.map((i) => i.id)).not.toContain(id);
      await api(ownerA.token)
        .delete(`/${id ?? ''}`)
        .expect(404);
    });
  });

  describe('accepting as a new user', () => {
    it('previews, then creates the user, membership and locations in one step', async () => {
      const email = newEmail();
      const token = await invite(email, { roleId: a.roles.manager, locationIds: [a.locations[0]] });
      const client = open();

      const preview = await client.preview(token).expect(200);
      expect(preview.body).toEqual({
        organizationName: 'Bistro A',
        email,
        role: { id: a.roles.manager, systemKey: 'manager', name: null },
        accountExists: false,
        expiresAt: expect.any(String) as unknown,
      });

      const res = await client.accept(token).expect(200);
      expect(res.body).toEqual({ organizationId: a.id });

      const user = await kit.raw.user.findUniqueOrThrow({ where: { email } });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.locale).toBe('de');
      expect(await roleOf(a.id, user.id)).toEqual({
        role: { systemKey: 'manager' },
        allLocations: false,
        locations: [{ locationId: a.locations[0] }],
      });
      const session = await kit.login(email, NEW_PASSWORD);
      expect(session.res.body).toMatchObject({ activeOrganizationId: a.id });
    });

    it('works once', async () => {
      const token = await invite(newEmail());
      const client = open();
      await client.accept(token).expect(200);
      const again = await client.accept(token).expect(400);
      expect(again.body).toMatchObject({ code: 'auth.token_invalid' });
    });

    it('never touches an existing account: 409, password unchanged', async () => {
      const existing = await kit.createUser();
      const token = await invite(existing.email);
      expect((await open().preview(token).expect(200)).body).toMatchObject({ accountExists: true });
      const res = await open().accept(token).expect(409);
      expect(res.body).toMatchObject({ code: 'invitations.sign_in_required' });

      const user = await kit.raw.user.findUniqueOrThrow({ where: { id: existing.id } });
      const hasher = kit.app.get(PasswordHasher);
      expect(await hasher.verify(user.passwordHash, PASSWORD)).toBe(true);
      expect(await hasher.verify(user.passwordHash, NEW_PASSWORD)).toBe(false);
      expect(await roleOf(a.id, existing.id)).toBeNull();
      // Still open: the user can sign in and accept.
      await open().preview(token).expect(200);
    });

    it('expires after 7 days', async () => {
      const token = await invite(newEmail());
      kit.clock.advance(7 * 24 * 3_600_000 + 1000);
      try {
        await open().preview(token).expect(400);
        await open().accept(token).expect(400);
      } finally {
        kit.clock.advance(-(7 * 24 * 3_600_000 + 1000));
      }
    });
  });

  describe('accepting as a signed-in user', () => {
    it("joins the invited organization, whatever the token's active organization", async () => {
      const existing = await member(b, b.roles.staff);
      const token = await invite(existing.email, { roleId: a.roles.admin });
      const session = await kit.login(existing.email);
      expect(session.res.body).toMatchObject({ activeOrganizationId: b.id });

      const res = await api(session.accessToken).post('/accept-signed-in', { token }).expect(200);
      expect(res.body).toEqual({ organizationId: a.id });
      expect(await roleOf(a.id, existing.id)).toMatchObject({ role: { systemKey: 'admin' } });
      // The token is consumed.
      await api(session.accessToken).post('/accept-signed-in', { token }).expect(400);
    });

    it('needs the invited email: 403, and the invitation stays open', async () => {
      const invitee = await kit.createUser();
      const other = await kit.createUser();
      const token = await invite(invitee.email);
      const session = await kit.login(other.email);
      const res = await api(session.accessToken).post('/accept-signed-in', { token }).expect(403);
      expect(res.body).toMatchObject({ code: 'invitations.email_mismatch' });
      expect(await roleOf(a.id, other.id)).toBeNull();
      await open().preview(token).expect(200);
    });

    it('needs a valid access token', async () => {
      const token = await invite(newEmail());
      await request(kit.server)
        .post('/api/v1/invitations/accept-signed-in')
        .send({ token })
        .expect(401);
    });
  });

  describe('invalid tokens', () => {
    it('all answer the same 400 auth.token_invalid', async () => {
      const valid = await invite(newEmail());
      const [org, secret] = valid.split('.') as [string, string];
      const revokedEmail = newEmail();
      const revoked = await invite(revokedEmail);
      const list = await api(ownerA.token).get('').expect(200);
      const revokedId = (list.body as { data: { id: string; email: string }[] }).data.find(
        (i) => i.email === revokedEmail,
      )?.id;
      await api(ownerA.token)
        .delete(`/${revokedId ?? ''}`)
        .expect(204);

      const cases = [
        'garbage',
        `not-a-uuid.${secret}`,
        `${org}.${'A'.repeat(43)}`,
        `${uuidv7()}.${secret}`,
        `${org}.${secret}.extra`,
        revoked,
      ];
      const bodies = [];
      for (const token of cases) {
        const client = open();
        const preview = await client.preview(token).expect(400);
        const accept = await client.accept(token).expect(400);
        bodies.push(preview.body, accept.body);
      }
      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
      expect(bodies[0]).toMatchObject({ code: 'auth.token_invalid' });
    });

    it("rejects a forged organization id with a valid secret from another tenant's invitation", async () => {
      const token = await invite(newEmail());
      const secret = token.split('.')[1] ?? '';
      const forged = `${b.id}.${secret}`;
      await open().preview(forged).expect(400);
      await open().accept(forged).expect(400);
      const someone = await member(b, b.roles.staff);
      await api(someone.token).post('/accept-signed-in', { token: forged }).expect(400);
      // The genuine token still works.
      await open().preview(token).expect(200);
    });

    it('rate limits preview and accept per IP', async () => {
      const client = open();
      for (let i = 0; i < 10; i++) await client.preview('garbage').expect(400);
      const res = await client.preview('garbage').expect(429);
      expect(res.body).toMatchObject({ code: 'auth.rate_limited' });
      await client.accept('garbage').expect(429);
    });
  });

  it('never logs a token or a link', async () => {
    const email = newEmail();
    const token = await invite(email);
    await open().preview(token).expect(200);
    await open().accept(token).expect(200);
    await kit.settle();
    const secret = token.split('.')[1] ?? '';
    const all = logs.join('\n');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('accept-invite#');
  });
});
