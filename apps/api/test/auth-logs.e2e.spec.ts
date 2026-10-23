import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/platform/auth/crypto';
import {
  type AuthTestKit,
  cookie,
  PASSWORD,
  refreshCookieOf,
  startAuthApp,
} from './support/auth-app';

const NEW_PASSWORD = 'a brand new passphrase';

/**
 * Runs every auth flow with trace logging and checks that no secret ever reaches the logs:
 * passwords, emails, access/refresh/reset/verification tokens, their hashes, or email links.
 */
describe('auth logs', () => {
  const logs: string[] = [];
  let kit: AuthTestKit;

  beforeAll(async () => {
    kit = await startAuthApp({ logs });
  });

  afterAll(async () => {
    await kit.close();
  });

  it('contain security events and no secrets', async () => {
    const secrets: string[] = [PASSWORD, NEW_PASSWORD];
    const keep = (...values: string[]) => {
      for (const v of values) secrets.push(v, hashToken(v));
    };

    const [orgA, orgB] = await Promise.all([kit.createOrg('A'), kit.createOrg('B')]);
    const user = await kit.createUser({ orgs: [orgA, orgB] });
    const unverified = await kit.createUser({ verified: false });
    secrets.push(user.email, unverified.email);
    const client = kit.client();

    // Failed and successful login, validation error carrying a password.
    await client
      .post('/login')
      .send({ email: user.email, password: 'wrong password!' })
      .expect(401);
    await client.post('/login').send({ email: 'x', password: 'validation-secret' }).expect(400);
    secrets.push('validation-secret', 'wrong password!');
    const login = await kit.login(user.email, PASSWORD, client);
    keep(login.accessToken, login.refresh);

    // Refresh, switch, me, reuse detection.
    const refreshed = await client
      .post('/refresh')
      .set('Cookie', cookie(login.refresh))
      .expect(200);
    const refresh2 = refreshCookieOf(refreshed);
    const access2 = (refreshed.body as { accessToken: string }).accessToken;
    keep(refresh2, access2);
    const switched = await client
      .post('/switch-organization')
      .set('Authorization', `Bearer ${access2}`)
      .set('Cookie', cookie(refresh2))
      .send({ organizationId: orgB })
      .expect(200);
    const refresh3 = refreshCookieOf(switched);
    keep(refresh3, (switched.body as { accessToken: string }).accessToken);
    await client.get('/me').set('Authorization', `Bearer ${access2}`).expect(200);
    await client.post('/refresh').set('Cookie', cookie(login.refresh)).expect(401);

    // Logout of a second session.
    const second = await kit.login(user.email, PASSWORD, client);
    keep(second.accessToken, second.refresh);
    await client.post('/logout').set('Cookie', cookie(second.refresh)).expect(204);

    // Forgot + reset, resend + verify.
    await client.post('/password/forgot').send({ email: user.email }).expect(202);
    const resetToken = await kit.tokenFromMail(user.email, 'reset-password');
    keep(resetToken);
    secrets.push(...kit.mailer.to(user.email).map((m) => m.text));
    await client
      .post('/password/reset')
      .send({ token: resetToken, password: NEW_PASSWORD })
      .expect(204);
    await client
      .post('/password/reset')
      .send({ token: resetToken, password: NEW_PASSWORD })
      .expect(400);
    await client.post('/verify-email/resend').send({ email: unverified.email }).expect(202);
    const verifyToken = await kit.tokenFromMail(unverified.email, 'verify-email');
    keep(verifyToken);
    await client.post('/verify-email').send({ token: verifyToken }).expect(204);
    await kit.settle();

    const all = logs.join('\n');
    expect(logs.length).toBeGreaterThan(20);
    for (const secret of secrets) {
      expect(all.includes(secret), `log contains a secret (${secret.slice(0, 6)}…)`).toBe(false);
    }
    expect(all).not.toMatch(/#token=/);

    // The organization switch is audited in the target organization instead (ADR 0008 §7).
    const events = logs
      .map((line) => (JSON.parse(line) as { security?: string }).security)
      .filter(Boolean);
    expect(new Set(events)).toEqual(
      new Set([
        'auth.login.failed',
        'auth.login.succeeded',
        'auth.refresh.reuse_detected',
        'auth.logout',
        'auth.password.reset_requested',
        'auth.password.reset',
        'auth.email.verification_requested',
        'auth.email.verified',
      ]),
    );
    expect(all).toMatch(/"template":"auth.reset"/);
  });
});
