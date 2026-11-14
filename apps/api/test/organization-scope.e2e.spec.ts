import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import {
  COOKIE,
  PASSWORD,
  randomIp,
  startAuthApp,
  WEB_ORIGIN,
  type AuthTestKit,
} from './support/auth-app';
import { planIdOf } from './support/plans';

/** The demo partner's local domain (migration 20261023…_partner_theming), served here through WEB_ORIGINS. */
const DEMO_HOST = 'partner-demo.localhost';
const DEMO_ORIGIN = `http://${DEMO_HOST}:3000`;

type Session = {
  accessToken: string;
  organizations: { id: string; name: string }[];
  activeOrganizationId: string | null;
};

/**
 * ADR 0042: one account, organizations of several partners; each site shows its own. A partner's served domain shows
 * that partner's organizations, the main site the others.
 */
describe('organizations by site', () => {
  let kit: AuthTestKit;
  let previousOrigins: string | undefined;
  let mainOrg: string;
  let demoOrg: string;
  let email: string;

  beforeAll(async () => {
    previousOrigins = process.env.WEB_ORIGINS;
    process.env.WEB_ORIGINS = `${WEB_ORIGIN},${DEMO_ORIGIN}`;
    kit = await startAuthApp();
    const platform = kit.app.get<PlatformPrismaClient>(PLATFORM_PRISMA);
    const demo = await platform.partner.findUniqueOrThrow({ where: { slug: 'demo' } });
    mainOrg = await kit.createOrg('A main-site organization');
    demoOrg = (
      await platform.organization.create({
        data: { partnerId: demo.id, name: 'A demo organization', planId: await planIdOf(platform) },
      })
    ).id;
    ({ email } = await kit.createUser({ orgs: [mainOrg, demoOrg] }));
  });

  afterAll(async () => {
    await kit.close();
    process.env.WEB_ORIGINS = previousOrigins;
  });

  /** A request as a browser on `site` would send it. */
  const on = (site: 'main' | 'demo', method: 'get' | 'post', path: string) => {
    const req = request(kit.server)
      [method](`/api/v1/auth${path}`)
      .set('X-Forwarded-For', randomIp());
    return site === 'demo'
      ? req.set('Host', DEMO_HOST).set('Origin', DEMO_ORIGIN)
      : req.set('Origin', WEB_ORIGIN);
  };

  async function login(site: 'main' | 'demo') {
    const res = await on(site, 'post', '/login').send({ email, password: PASSWORD }).expect(200);
    const cookie = ((res.headers['set-cookie'] as unknown as string[]) ?? []).find((c) =>
      c.startsWith(`${COOKIE}=`),
    );
    return { body: res.body as Session, cookie: cookie?.split(';')[0] ?? '' };
  }

  it('signs in to the organization of the site it is on', async () => {
    const main = await login('main');
    expect(main.body.organizations.map((o) => o.id)).toEqual([mainOrg]);
    expect(main.body.activeOrganizationId).toBe(mainOrg);

    const demo = await login('demo');
    expect(demo.body.organizations.map((o) => o.id)).toEqual([demoOrg]);
    expect(demo.body.activeOrganizationId).toBe(demoOrg);
  });

  it("lists only the site's organizations in /me", async () => {
    const demo = await login('demo');
    const me = await on('demo', 'get', '/me')
      .auth(demo.body.accessToken, { type: 'bearer' })
      .expect(200);
    expect((me.body as Session).organizations.map((o) => o.id)).toEqual([demoOrg]);
  });

  it("refuses switching to another site's organization", async () => {
    const main = await login('main');
    const res = await on('main', 'post', '/switch-organization')
      .auth(main.body.accessToken, { type: 'bearer' })
      .set('Cookie', main.cookie)
      .send({ organizationId: demoOrg })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'auth.not_a_member' });
  });

  it("moves a refreshed session to the site's organization", async () => {
    // A session that remembers the main-site organization, refreshed on the demo site (e.g. from before ADR 0042).
    const main = await login('main');
    const res = await on('demo', 'post', '/refresh').set('Cookie', main.cookie).expect(200);
    expect((res.body as Session).activeOrganizationId).toBe(demoOrg);
    expect((res.body as Session).organizations.map((o) => o.id)).toEqual([demoOrg]);
  });
});
