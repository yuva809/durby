import { sessionResponseSchema } from '@durby/shared';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthTestKit, COOKIE, PASSWORD, startAuthApp } from './support/auth-app';

/**
 * Several accounts on one browser (docs/platform/auth.md → Several accounts, ADR 0047): each slot has its own refresh
 * cookie, picked by X-Durby-Account; signing in, refreshing or out in one slot leaves the others alone.
 */
describe('signed-in accounts per slot', () => {
  let kit: AuthTestKit;

  beforeAll(async () => {
    kit = await startAuthApp();
  });

  afterAll(async () => {
    await kit.close();
  });

  const nameOf = (slot: number) => (slot === 0 ? COOKIE : `${COOKIE}_${slot}`);

  /** The cookie the response set for `slot`: its value, or '' when it was cleared. */
  function setFor(res: request.Response, slot: number): string | undefined {
    const raw = res.headers['set-cookie'] as unknown;
    const cookies = Array.isArray(raw) ? (raw as string[]) : [];
    const header = cookies.find((c) => c.startsWith(`${nameOf(slot)}=`));
    return header?.split(';')[0]?.slice(nameOf(slot).length + 1);
  }

  it('keeps one sign-in per slot', async () => {
    const org = await kit.createOrg('Alpha');
    const [anna, ben] = await Promise.all([
      kit.createUser({ orgs: [org] }),
      kit.createUser({ orgs: [org] }),
    ]);
    const client = kit.client();
    const login = (email: string, slot: number) =>
      client
        .post('/login')
        .set('X-Durby-Account', String(slot))
        .send({ email, password: PASSWORD })
        .expect(200);

    const first = await login(anna.email, 0);
    const second = await login(ben.email, 2);
    // Each answer sets only its own slot's cookie.
    expect(setFor(first, 0)).toBeTruthy();
    expect(setFor(second, 2)).toBeTruthy();
    expect(setFor(second, 0)).toBeUndefined();
    const jar = { 0: setFor(first, 0)!, 2: setFor(second, 2)! };
    const cookies = () => `${nameOf(0)}=${jar[0]}; ${nameOf(2)}=${jar[2]}`;

    const refresh = async (slot: 0 | 2) => {
      const res = await client
        .post('/refresh')
        .set('X-Durby-Account', String(slot))
        .set('Cookie', cookies())
        .expect(200);
      jar[slot] = setFor(res, slot)!;
      return sessionResponseSchema.parse(res.body).user.email;
    };
    expect(await refresh(2)).toBe(ben.email);
    expect(await refresh(0)).toBe(anna.email);

    // Signing out of slot 2 leaves slot 0 signed in.
    const out = await client
      .post('/logout')
      .set('X-Durby-Account', '2')
      .set('Cookie', cookies())
      .expect(204);
    expect(setFor(out, 2)).toBe('');
    await client.post('/refresh').set('X-Durby-Account', '2').set('Cookie', cookies()).expect(401);
    expect(await refresh(0)).toBe(anna.email);
  });

  it('refuses a slot outside 0 to 4', async () => {
    await kit.client().post('/refresh').set('X-Durby-Account', '5').expect(400);
    await kit.client().post('/refresh').set('X-Durby-Account', 'x').expect(400);
  });
});
