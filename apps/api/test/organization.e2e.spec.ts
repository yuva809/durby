import { organizationSchema } from '@durby/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_PRISMA, type PlatformPrismaClient } from '../src/platform/tenancy';
import { startAuthApp, type AuthTestKit } from './support/auth-app';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/platform/web-shell.md → Organization profile. */
describe('PATCH /organization', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let platform: PlatformPrismaClient;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    platform = kit.app.get<PlatformPrismaClient>(PLATFORM_PRISMA);
  });

  afterAll(async () => {
    await kit.close();
  });

  async function tokenAs(org: SeededOrg, roleId: string) {
    const user = await kit.createUser();
    await seed.member(org.id, user.id, roleId);
    return seed.token(user.id, org.id);
  }

  const rename = (token: string, body: object) =>
    withIdempotencyKey(
      request(kit.server).patch('/api/v1/organization').auth(token, { type: 'bearer' }),
    ).send(body);

  const nameOf = async (id: string) =>
    (await platform.organization.findUniqueOrThrow({ where: { id } })).name;

  const audit = (orgId: string) =>
    seed.as(orgId, (db) =>
      db.auditLog.findMany({
        where: { action: 'platform.organization.updated' },
        select: { entityId: true, before: true, after: true },
      }),
    );

  it("renames the token's organization (trimmed) and audits it; the same name writes nothing", async () => {
    const org = await seed.org('Old name');
    const token = await tokenAs(org, org.roles.owner);
    const res = await rename(token, { name: '  New name  ' }).expect(200);
    expect(organizationSchema.parse(res.body)).toEqual({ id: org.id, name: 'New name' });
    expect(await nameOf(org.id)).toBe('New name');
    expect(await audit(org.id)).toEqual([
      {
        entityId: org.id,
        before: { id: org.id, name: 'Old name' },
        after: { id: org.id, name: 'New name' },
      },
    ]);

    await rename(token, { name: 'New name' }).expect(200);
    expect(await audit(org.id)).toHaveLength(1);
  });

  it('needs platform.org.manage (Admins lack it)', async () => {
    const org = await seed.org('Kept');
    const res = await rename(await tokenAs(org, org.roles.admin), { name: 'Changed' }).expect(403);
    expect(res.body).toMatchObject({
      code: 'rbac.permission_denied',
      details: { permission: 'platform.org.manage' },
    });
    expect(await nameOf(org.id)).toBe('Kept');
  });

  it('validates the name: 1–100 characters after trimming, no other fields', async () => {
    const org = await seed.org('Valid');
    const token = await tokenAs(org, org.roles.owner);
    for (const body of [
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 'A', id: org.id },
      {},
    ]) {
      const res = await rename(token, body).expect(400);
      expect(res.body).toMatchObject({ code: 'validation.failed' });
    }
    expect(await nameOf(org.id)).toBe('Valid');
  });

  it('never touches another organization (tenant from the token, not the request)', async () => {
    const [a, b] = await Promise.all([seed.org('A'), seed.org('B')]);
    await rename(await tokenAs(a, a.roles.owner), { name: 'A renamed' }).expect(200);
    expect(await nameOf(b.id)).toBe('B');
    expect(await audit(b.id)).toEqual([]);
  });
});
