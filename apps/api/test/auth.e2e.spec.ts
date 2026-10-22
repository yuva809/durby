import { sessionResponseSchema, type SessionResponse } from '@durby/shared';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AuthTestKit,
  cookie,
  PASSWORD,
  refreshCookieOf,
  setCookieHeader,
  startAuthApp,
  WEB_ORIGIN,
} from './support/auth-app';

// Every auth flow end to end (docs/platform/auth.md). Each test creates its own users and
// organizations and uses its own client IP (X-Forwarded-For), so rate limits stay per test.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NEW_PASSWORD = 'a brand new passphrase';

describe('auth', () => {
  let kit: AuthTestKit;

  beforeAll(async () => {
    kit = await startAuthApp();
  });

  afterAll(async () => {
    await kit.close();
  });

  beforeEach(() => {
    kit.clock.set(new Date());
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const me = (token: string) => kit.client().get('/me').set(bearer(token));
  const sessionOf = (body: unknown): SessionResponse => sessionResponseSchema.parse(body);

  describe('POST /login', () => {
    it('returns a session, sets the refresh cookie and picks the last organization', async () => {
      const [orgA, orgB] = await Promise.all([kit.createOrg('Alpha'), kit.createOrg('Beta')]);
      const user = await kit.createUser({ orgs: [orgA, orgB] });
      await kit.raw.user.update({ where: { id: user.id }, data: { lastOrganizationId: orgB } });

      const { res, accessToken } = await kit.login(user.email);
      expect(sessionOf(res.body)).toEqual({
        accessToken,
        expiresIn: 600,
        user: { id: user.id, email: user.email, locale: 'en' },
        organizations: [
          { id: orgA, name: 'Alpha' },
          { id: orgB, name: 'Beta' },
        ],
        activeOrganizationId: orgB,
      });
      expect(res.headers['cache-control']).toBe('no-store');
      const header = setCookieHeader(res) ?? '';
      expect(header).toMatch(/; Path=\/api\/v1\/auth/);
      expect(header).toMatch(/; HttpOnly/);
      expect(header).toMatch(/; Secure/);
      expect(header).toMatch(/; SameSite=Strict/);
      expect(header).toMatch(/; Expires=/);
      await me(accessToken).expect(200);
    });

    it('falls back to the first organization by name, or none', async () => {
      const [orgB, orgA] = await Promise.all([kit.createOrg('Bravo'), kit.createOrg('Able')]);
      const member = await kit.createUser({ orgs: [orgB, orgA] });
      expect(sessionOf((await kit.login(member.email)).res.body).activeOrganizationId).toBe(orgA);

      const loner = await kit.createUser();
      const session = sessionOf((await kit.login(loner.email)).res.body);
      expect(session).toMatchObject({ organizations: [], activeOrganizationId: null });
    });

    it('matches emails case-insensitively', async () => {
      const user = await kit.createUser();
      await kit.login(`  ${user.email.toUpperCase()} `);
    });

    it('answers identically for unknown email, wrong password and no password set', async () => {
      const user = await kit.createUser();
      const noPassword = await kit.createUser({ password: null });
      const attempt = async (email: string, password: string) => {
        const res = await kit.client().post('/login').send({ email, password });
        return { status: res.status, body: res.body as unknown, cookie: setCookieHeader(res) };
      };
      const unknown = await attempt(`nobody-${uuidv7()}@example.test`, PASSWORD);
      expect(unknown).toEqual({
        status: 401,
        body: { code: 'auth.invalid_credentials', message: expect.any(String) as unknown },
        cookie: undefined,
      });
      expect(await attempt(user.email, 'wrong password!')).toEqual(unknown);
      expect(await attempt(noPassword.email, PASSWORD)).toEqual(unknown);
    });

    it('rejects an unverified email only after a correct password', async () => {
      const user = await kit.createUser({ verified: false });
      await kit
        .client()
        .post('/login')
        .send({ email: user.email, password: 'wrong password!' })
        .expect(401);
      const res = await kit
        .client()
        .post('/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'auth.email_not_verified' });
      expect(setCookieHeader(res)).toBeUndefined();
    });

    it('requires an allowed Origin', async () => {
      const user = await kit.createUser();
      const body = { email: user.email, password: PASSWORD };
      for (const origin of [null, 'https://evil.test']) {
        const res = await kit.client().post('/login', origin).send(body).expect(403);
        expect(res.body).toMatchObject({ code: 'auth.origin_rejected' });
      }
    });

    it('validates the body without echoing it', async () => {
      const res = await kit
        .client()
        .post('/login')
        .send({ email: 'not-an-email', password: 'secret-password-value' })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'validation.failed' });
      expect(JSON.stringify(res.body)).not.toContain('secret-password-value');
    });
  });

  describe('lockout', () => {
    const fail = async (email: string, times: number) => {
      const statuses: number[] = [];
      for (let i = 0; i < times; i++) {
        statuses.push(
          (await kit.client().post('/login').send({ email, password: 'wrong password!' })).status,
        );
      }
      return statuses;
    };

    it('locks after 5 failures, even for the right password, with Retry-After', async () => {
      const user = await kit.createUser();
      expect(await fail(user.email, 5)).toEqual([401, 401, 401, 401, 401]);
      const res = await kit
        .client()
        .post('/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(429);
      expect(res.body).toMatchObject({ code: 'auth.too_many_attempts' });
      expect(res.headers['retry-after']).toBe('60');
    });

    it('locks unknown emails exactly the same way', async () => {
      const email = `nobody-${uuidv7()}@example.test`;
      expect(await fail(email, 6)).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('is temporary: after the lock the right password works and resets the count', async () => {
      const user = await kit.createUser();
      await fail(user.email, 5);
      kit.clock.advance(61_000);
      await kit.login(user.email);
      expect(await fail(user.email, 4)).toEqual([401, 401, 401, 401]);
    });

    it('a password reset clears the lock', async () => {
      const user = await kit.createUser();
      await fail(user.email, 5);
      await kit.client().post('/password/forgot').send({ email: user.email }).expect(202);
      const token = await kit.tokenFromMail(user.email, 'reset-password');
      await kit
        .client()
        .post('/password/reset')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);
      await kit.login(user.email, NEW_PASSWORD);
    });
  });

  describe('rate limits', () => {
    it('limits logins per IP with 429 auth.rate_limited and Retry-After', async () => {
      const client = kit.client();
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) {
        const res = await client
          .post('/login')
          .send({ email: `n${i}-${uuidv7()}@example.test`, password: 'x' });
        statuses.push(res.status);
        if (res.status === 429) {
          expect(res.body).toMatchObject({ code: 'auth.rate_limited' });
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        }
      }
      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(statuses[20]).toBe(429);
      // Another client is unaffected.
      const user = await kit.createUser();
      await kit.login(user.email);
    });

    it('limits forgot-password per email', async () => {
      const email = `nobody-${uuidv7()}@example.test`;
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await kit.client().post('/password/forgot').send({ email })).status);
      }
      expect(statuses).toEqual([202, 202, 202, 429]);
    });
  });

  describe('POST /refresh', () => {
    it('rotates the refresh token and issues a new access token', async () => {
      const org = await kit.createOrg('Org');
      const user = await kit.createUser({ orgs: [org] });
      const { refresh } = await kit.login(user.email);

      const res = await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(200);
      const next = refreshCookieOf(res);
      expect(next).not.toBe(refresh);
      expect(sessionOf(res.body)).toMatchObject({
        activeOrganizationId: org,
        user: { id: user.id },
      });
      await me(sessionOf(res.body).accessToken).expect(200);
      await kit.client().post('/refresh').set('Cookie', cookie(next)).expect(200);
    });

    it('reuse of a used token revokes the whole family, including its access tokens', async () => {
      const user = await kit.createUser();
      const { refresh: first } = await kit.login(user.email);
      const rotated = await kit.client().post('/refresh').set('Cookie', cookie(first)).expect(200);
      const second = refreshCookieOf(rotated);
      const access = sessionOf(rotated.body).accessToken;

      const reuse = await kit.client().post('/refresh').set('Cookie', cookie(first)).expect(401);
      expect(reuse.body).toMatchObject({ code: 'auth.refresh_reused' });
      expect(setCookieHeader(reuse)).toMatch(/Expires=Thu, 01 Jan 1970/);

      // The newest token was not reused, but its family is revoked.
      const after = await kit.client().post('/refresh').set('Cookie', cookie(second)).expect(401);
      expect(after.body).toMatchObject({ code: 'auth.refresh_invalid' });
      await me(access).expect(401);
      // Other sessions of the same user are untouched.
      const other = await kit.login(user.email);
      await kit.client().post('/refresh').set('Cookie', cookie(other.refresh)).expect(200);
    });

    it('concurrent use of one token: one wins, the family is revoked', async () => {
      const user = await kit.createUser();
      const { refresh } = await kit.login(user.email);
      const results = await Promise.all(
        [1, 2].map(() => kit.client().post('/refresh').set('Cookie', cookie(refresh))),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      const winner = results.find((r) => r.status === 200);
      await kit
        .client()
        .post('/refresh')
        .set('Cookie', cookie(refreshCookieOf(winner!)))
        .expect(401);
    });

    it('rejects a missing or unknown cookie and clears it', async () => {
      const missing = await kit.client().post('/refresh').expect(401);
      expect(missing.body).toMatchObject({ code: 'auth.refresh_invalid' });
      const unknown = await kit
        .client()
        .post('/refresh')
        .set('Cookie', cookie('A'.repeat(43)))
        .expect(401);
      expect(unknown.body).toMatchObject({ code: 'auth.refresh_invalid' });
      expect(setCookieHeader(unknown)).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('expires after 14 days unused', async () => {
      const user = await kit.createUser();
      const { refresh } = await kit.login(user.email);
      kit.clock.advance(14 * DAY + MIN);
      const res = await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(401);
      expect(res.body).toMatchObject({ code: 'auth.refresh_invalid' });
    });

    it('ends the family after 30 days even when used regularly', async () => {
      const user = await kit.createUser();
      let { refresh } = await kit.login(user.email);
      for (let day = 10; day < 30; day += 10) {
        kit.clock.advance(10 * DAY);
        const res = await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(200);
        refresh = refreshCookieOf(res);
      }
      kit.clock.advance(10 * DAY);
      await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(401);
    });

    it('requires an allowed Origin and leaves the token usable when rejected', async () => {
      const user = await kit.createUser();
      const { refresh } = await kit.login(user.email);
      await kit.client().post('/refresh', null).set('Cookie', cookie(refresh)).expect(403);
      await kit
        .client()
        .post('/refresh', 'https://evil.test')
        .set('Cookie', cookie(refresh))
        .expect(403);
      await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(200);
    });

    it('drops the organization once the membership is gone', async () => {
      const org = await kit.createOrg('Org');
      const user = await kit.createUser({ orgs: [org] });
      const { refresh } = await kit.login(user.email);
      await kit.leave(org, user.id);
      const res = await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(200);
      expect(sessionOf(res.body)).toMatchObject({ activeOrganizationId: null, organizations: [] });
    });
  });

  describe('POST /logout', () => {
    it('ends the session at once and clears the cookie', async () => {
      const user = await kit.createUser();
      const { refresh, accessToken } = await kit.login(user.email);
      const res = await kit.client().post('/logout').set('Cookie', cookie(refresh)).expect(204);
      expect(setCookieHeader(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(setCookieHeader(res)).toMatch(/Path=\/api\/v1\/auth/);
      await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(401);
      await me(accessToken).expect(401);
    });

    it('works without a cookie or with a dead one, and needs no access token', async () => {
      await kit.client().post('/logout').expect(204);
      await kit
        .client()
        .post('/logout')
        .set('Cookie', cookie('A'.repeat(43)))
        .expect(204);
    });

    it('requires an allowed Origin', async () => {
      const user = await kit.createUser();
      const { refresh } = await kit.login(user.email);
      await kit
        .client()
        .post('/logout', 'https://evil.test')
        .set('Cookie', cookie(refresh))
        .expect(403);
      await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(200);
    });
  });

  describe('POST /switch-organization', () => {
    async function memberOfTwo() {
      const [orgA, orgB] = await Promise.all([kit.createOrg('A'), kit.createOrg('B')]);
      const user = await kit.createUser({ orgs: [orgA, orgB] });
      await kit.raw.user.update({ where: { id: user.id }, data: { lastOrganizationId: orgA } });
      return { orgA, orgB, user, ...(await kit.login(user.email)) };
    }

    it('switches to a member organization; refresh and the next login keep it', async () => {
      const { orgB, user, refresh, accessToken } = await memberOfTwo();
      const res = await kit
        .client()
        .post('/switch-organization')
        .set(bearer(accessToken))
        .set('Cookie', cookie(refresh))
        .send({ organizationId: orgB })
        .expect(200);
      const session = sessionOf(res.body);
      expect(session.activeOrganizationId).toBe(orgB);
      const meRes = await me(session.accessToken).expect(200);
      expect(meRes.body).toMatchObject({ activeOrganizationId: orgB });

      const refreshed = await kit
        .client()
        .post('/refresh')
        .set('Cookie', cookie(refreshCookieOf(res)))
        .expect(200);
      expect(sessionOf(refreshed.body).activeOrganizationId).toBe(orgB);
      // The old cookie was consumed by the switch.
      await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(401);
      expect(sessionOf((await kit.login(user.email)).res.body).activeOrganizationId).toBe(orgB);
    });

    it('403 for an organization the user is not a member of, session untouched', async () => {
      const { refresh, accessToken } = await memberOfTwo();
      const foreign = await kit.createOrg('Foreign');
      for (const organizationId of [foreign, uuidv7()]) {
        const res = await kit
          .client()
          .post('/switch-organization')
          .set(bearer(accessToken))
          .set('Cookie', cookie(refresh))
          .send({ organizationId })
          .expect(403);
        expect(res.body).toMatchObject({ code: 'auth.not_a_member' });
        expect(setCookieHeader(res)).toBeUndefined();
      }
      await kit.client().post('/refresh').set('Cookie', cookie(refresh)).expect(200);
    });

    it('needs an access token, an allowed Origin and the session’s own cookie', async () => {
      const { orgB, refresh, accessToken } = await memberOfTwo();
      await kit
        .client()
        .post('/switch-organization')
        .set('Cookie', cookie(refresh))
        .send({ organizationId: orgB })
        .expect(401);
      await kit
        .client()
        .post('/switch-organization', 'https://evil.test')
        .set(bearer(accessToken))
        .set('Cookie', cookie(refresh))
        .send({ organizationId: orgB })
        .expect(403);
      const otherSession = await kit.login((await kit.createUser()).email);
      const res = await kit
        .client()
        .post('/switch-organization')
        .set(bearer(accessToken))
        .set('Cookie', cookie(otherSession.refresh))
        .send({ organizationId: orgB })
        .expect(401);
      expect(res.body).toMatchObject({ code: 'auth.refresh_invalid' });
    });
  });

  describe('GET /me', () => {
    it('returns the user, organizations and active organization', async () => {
      const org = await kit.createOrg('Org');
      const user = await kit.createUser({ orgs: [org], locale: 'de' });
      const { accessToken } = await kit.login(user.email);
      const res = await me(accessToken).expect(200);
      expect(res.body).toEqual({
        user: { id: user.id, email: user.email, locale: 'de' },
        organizations: [{ id: org, name: 'Org' }],
        activeOrganizationId: org,
      });
    });

    it('requires an access token', async () => {
      await kit.client().get('/me').expect(401);
    });
  });

  describe('password reset', () => {
    it('answers the same for known and unknown emails; mails only known ones', async () => {
      const user = await kit.createUser();
      const unknown = `nobody-${uuidv7()}@example.test`;
      const a = await kit.client().post('/password/forgot').send({ email: user.email });
      const b = await kit.client().post('/password/forgot').send({ email: unknown });
      expect([a.status, a.body]).toEqual([b.status, b.body]);
      expect(a.status).toBe(202);
      await kit.tokenFromMail(user.email, 'reset-password');
      await kit.settle();
      expect(kit.mailer.to(unknown)).toEqual([]);
    });

    it('sets the password, single use, and ends every session', async () => {
      const user = await kit.createUser();
      const sessionA = await kit.login(user.email);
      const sessionB = await kit.login(user.email);
      await kit.client().post('/password/forgot').send({ email: user.email }).expect(202);
      const token = await kit.tokenFromMail(user.email, 'reset-password');
      kit.clock.advance(1_000);

      await kit
        .client()
        .post('/password/reset')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);

      const again = await kit
        .client()
        .post('/password/reset')
        .send({ token, password: 'yet another passphrase' })
        .expect(400);
      expect(again.body).toMatchObject({ code: 'auth.token_invalid' });
      for (const session of [sessionA, sessionB]) {
        await kit.client().post('/refresh').set('Cookie', cookie(session.refresh)).expect(401);
        await me(session.accessToken).expect(401);
      }
      await kit.client().post('/login').send({ email: user.email, password: PASSWORD }).expect(401);
      const fresh = await kit.login(user.email, NEW_PASSWORD);
      await me(fresh.accessToken).expect(200);
    });

    it('lets a user without a password (bootstrap admin) set one and verifies the email', async () => {
      const user = await kit.createUser({ password: null, verified: false });
      await kit.client().post('/password/forgot').send({ email: user.email }).expect(202);
      const token = await kit.tokenFromMail(user.email, 'reset-password');
      await kit
        .client()
        .post('/password/reset')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);
      await kit.login(user.email, NEW_PASSWORD);
    });

    it('rejects expired tokens and tokens replaced by a newer request', async () => {
      const user = await kit.createUser();
      await kit.client().post('/password/forgot').send({ email: user.email }).expect(202);
      const older = await kit.tokenFromMail(user.email, 'reset-password');
      await kit.client().post('/password/forgot').send({ email: user.email }).expect(202);
      await kit.settle();
      const newer = await kit.tokenFromMail(user.email, 'reset-password');
      expect(newer).not.toBe(older);

      await kit
        .client()
        .post('/password/reset')
        .send({ token: older, password: NEW_PASSWORD })
        .expect(400);
      kit.clock.advance(31 * MIN);
      await kit
        .client()
        .post('/password/reset')
        .send({ token: newer, password: NEW_PASSWORD })
        .expect(400);
    });

    it('enforces the password policy', async () => {
      const res = await kit
        .client()
        .post('/password/reset')
        .send({ token: 'A'.repeat(43), password: 'too short' })
        .expect(400);
      expect(res.body).toMatchObject({ code: 'validation.failed' });
    });

    it('mails in the user’s language', async () => {
      const user = await kit.createUser({ locale: 'de' });
      await kit.client().post('/password/forgot').send({ email: user.email }).expect(202);
      await kit.tokenFromMail(user.email, 'reset-password');
      expect(kit.mailer.to(user.email)[0]?.subject).toBe('Neues Passwort festlegen');
    });
  });

  describe('email verification', () => {
    it('resend mails a link; verifying lets the user log in; the link works once', async () => {
      const user = await kit.createUser({ verified: false });
      await kit.client().post('/verify-email/resend').send({ email: user.email }).expect(202);
      const token = await kit.tokenFromMail(user.email, 'verify-email');
      await kit.client().post('/verify-email').send({ token }).expect(204);
      await kit.login(user.email);
      const again = await kit.client().post('/verify-email').send({ token }).expect(400);
      expect(again.body).toMatchObject({ code: 'auth.token_invalid' });
    });

    it('answers 202 for unknown and already verified emails without mailing', async () => {
      const verified = await kit.createUser();
      const unknown = `nobody-${uuidv7()}@example.test`;
      await kit.client().post('/verify-email/resend').send({ email: verified.email }).expect(202);
      await kit.client().post('/verify-email/resend').send({ email: unknown }).expect(202);
      await kit.settle();
      expect(kit.mailer.to(verified.email)).toEqual([]);
      expect(kit.mailer.to(unknown)).toEqual([]);
    });

    it('rejects expired verification tokens', async () => {
      const user = await kit.createUser({ verified: false });
      await kit.client().post('/verify-email/resend').send({ email: user.email }).expect(202);
      const token = await kit.tokenFromMail(user.email, 'verify-email');
      kit.clock.advance(24 * 60 * MIN + MIN);
      await kit.client().post('/verify-email').send({ token }).expect(400);
    });
  });

  it('links in emails point at WEB_BASE_URL with the token in the fragment', async () => {
    const user = await kit.createUser();
    await kit.client().post('/password/forgot').send({ email: user.email }).expect(202);
    await kit.tokenFromMail(user.email, 'reset-password');
    expect(kit.mailer.to(user.email)[0]?.text).toMatch(
      new RegExp(`${WEB_ORIGIN}/reset-password#token=[A-Za-z0-9_-]{43}`),
    );
    expect(kit.mailer.to(user.email)[0]?.text).not.toContain('?token=');
  });
});
