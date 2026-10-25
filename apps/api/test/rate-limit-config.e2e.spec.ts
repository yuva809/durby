import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAuthApp, type AuthTestKit } from './support/auth-app';

/** docs/platform/web-shell.md → Rate limits in end-to-end runs (ADR 0015 §14). */
describe('configured auth rate limits', () => {
  let kit: AuthTestKit;

  beforeAll(async () => {
    // Read when the app boots; this file's worker only.
    process.env.RATE_LIMIT_LOGIN_IP = '25';
    process.env.RATE_LIMIT_LOGIN_EMAIL = '2';
    kit = await startAuthApp();
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_LOGIN_IP;
    delete process.env.RATE_LIMIT_LOGIN_EMAIL;
    await kit.close();
  });

  it('enforces the counts from the env vars', async () => {
    // Per email: 2 instead of 10.
    const email = `limited-${uuidv7()}@example.test`;
    const byEmail = [];
    for (let i = 0; i < 3; i++) {
      byEmail.push((await kit.client().post('/login').send({ email, password: 'x' })).status);
    }
    expect(byEmail).toEqual([401, 401, 429]);

    // Per IP: 25 instead of 20 (one client, distinct emails).
    const client = kit.client();
    const byIp = [];
    for (let i = 0; i < 26; i++) {
      const res = await client
        .post('/login')
        .send({ email: `n${i}-${uuidv7()}@example.test`, password: 'x' });
      byIp.push(res.status);
    }
    expect(byIp.slice(0, 25).every((s) => s === 401)).toBe(true);
    expect(byIp[25]).toBe(429);
  });
});
