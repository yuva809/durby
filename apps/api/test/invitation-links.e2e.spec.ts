import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { startAuthApp, WEB_ORIGIN, type AuthTestKit } from './support/auth-app';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** The demo partner's local domain (migration 20261023…_partner_theming). */
const DEMO_ORIGIN = 'http://partner-demo.localhost:3000';

/** docs/platform/web-shell.md → Invitation links (ADR 0015 §12). */
describe('invitation links', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let durby: SeededOrg;
  let demo: SeededOrg;

  beforeAll(async () => {
    // Read when the app boots: both origins allowed, WEB_BASE_URL stays the fallback.
    process.env.WEB_ORIGINS = `${WEB_ORIGIN},${DEMO_ORIGIN}`;
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    const platform = kit.app.get<PlatformPrismaClient>(PLATFORM_PRISMA);
    const partner = await platform.partner.findUniqueOrThrow({ where: { slug: 'demo' } });
    [durby, demo] = await Promise.all([
      seed.org('On its own partner'),
      seed.org('On the demo partner', { partnerId: partner.id }),
    ]);
  });

  afterAll(async () => {
    await kit.close();
  });

  /** Invites as an Owner of `org` and returns the origin of the link in the mail. */
  async function linkOf(org: SeededOrg, forwardedHost?: string): Promise<string> {
    const user = await kit.createUser();
    await seed.member(org.id, user.id, org.roles.owner);
    const token = await seed.token(user.id, org.id);
    const email = `invitee-${uuidv7()}@example.test`;
    let req = request(kit.server).post('/api/v1/invitations').auth(token, { type: 'bearer' });
    if (forwardedHost) req = req.set('X-Forwarded-Host', forwardedHost);
    await withIdempotencyKey(req).send({ email, roleId: org.roles.staff }).expect(201);
    for (let i = 0; i < 100 && kit.mailer.to(email).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const match = /(\S+)\/accept-invite#token=/.exec(kit.mailer.to(email).at(-1)?.text ?? '');
    expect(match, 'invitation link in mail').not.toBeNull();
    return match?.[1] ?? '';
  }

  it("opens on the partner's domain when it is an allowed origin", async () => {
    expect(await linkOf(demo)).toBe(DEMO_ORIGIN);
  });

  it('falls back to WEB_BASE_URL for a partner without domains', async () => {
    expect(await linkOf(durby)).toBe(WEB_ORIGIN);
  });

  it("ignores the request's Host and X-Forwarded-Host", async () => {
    expect(await linkOf(durby, 'partner-demo.localhost:3000')).toBe(WEB_ORIGIN);
  });
});
