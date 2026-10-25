import { locationListResponseSchema } from '@durby/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAuthApp, type AuthTestKit } from './support/auth-app';
import { RbacSeed, type SeededOrg } from './support/rbac';

/** docs/platform/web-shell.md → Locations (ADR 0015 §11). */
describe('GET /locations', () => {
  let kit: AuthTestKit;
  let seed: RbacSeed;
  let a: SeededOrg;
  let b: SeededOrg;

  beforeAll(async () => {
    kit = await startAuthApp();
    seed = new RbacSeed(kit.app);
    [a, b] = await Promise.all([seed.org('A'), seed.org('B')]);
  });

  afterAll(async () => {
    await kit.close();
  });

  async function tokenAs(org: SeededOrg, roleId: string, locations?: string[]) {
    const user = await kit.createUser();
    await seed.member(org.id, user.id, roleId, locations ? { locations } : {});
    return seed.token(user.id, org.id);
  }

  const list = (token: string) =>
    request(kit.server).get('/api/v1/locations').auth(token, { type: 'bearer' });

  it('lists every location of the organization for an all-locations member (Staff too)', async () => {
    const res = await list(await tokenAs(a, a.roles.staff)).expect(200);
    const body = locationListResponseSchema.parse(res.body);
    expect(body.data.map((l) => l.id).sort()).toEqual([...a.locations].sort());
    expect(body.data.map((l) => l.name)).toEqual(['L1', 'L2']);
  });

  it('shows a location-limited member only their locations', async () => {
    const token = await tokenAs(a, a.roles.staff, [a.locations[1]]);
    const res = await list(token).expect(200);
    expect(locationListResponseSchema.parse(res.body).data.map((l) => l.id)).toEqual([
      a.locations[1],
    ]);
  });

  it('needs platform.settings.read', async () => {
    const role = await seed.customRole(a.id, ['platform.users.read']);
    const res = await list(await tokenAs(a, role)).expect(403);
    expect(res.body).toMatchObject({
      code: 'rbac.permission_denied',
      details: { permission: 'platform.settings.read' },
    });
  });

  it("never shows another organization's locations", async () => {
    const res = await list(await tokenAs(b, b.roles.owner)).expect(200);
    const ids = locationListResponseSchema.parse(res.body).data.map((l) => l.id);
    expect(ids.sort()).toEqual([...b.locations].sort());
    expect(ids).not.toContain(a.locations[0]);
  });
});
