import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FEATURE_KEYS, meEntitlementsResponseSchema } from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { RbacSeed } from './support/rbac';
import { EMPTY_TEST_PLAN, emptyPlanFor } from './support/plans';

const ACTOR = 'cli.entitlements';

// ADR 0009 §6: /me/entitlements and activeFeatures read only the token's active organization, and
// only for a member of it.
describe('GET /me/entitlements and activeFeatures', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let admin: EntitlementsAdmin;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    admin = app.get(EntitlementsAdmin);
  });

  afterAll(async () => {
    await app.close();
  });

  const entitlements = async (token: string) =>
    meEntitlementsResponseSchema.parse(
      (
        await request(server)
          .get('/api/v1/me/entitlements')
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body,
    );

  const activeFeatures = async (token: string) =>
    (
      (
        await request(server)
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as { activeFeatures: string[] }
    ).activeFeatures;

  it('lists the enabled features with every limit (null = unlimited) and the plan', async () => {
    const org = await seed.org();
    const user = await seed.user();
    await seed.member(org.id, user, org.roles.staff);
    await admin.setPlan(org.id, 'full', ACTOR);
    await admin.setOverride(org.id, 'api.public', true, { requestsPerMinute: 120 }, ACTOR);
    await admin.setOverride(org.id, 'pos', false, undefined, ACTOR);
    const token = await seed.token(user, org.id);

    const body = await entitlements(token);
    expect(body.plan).toEqual({ key: 'full' });
    const enabled = FEATURE_KEYS.filter((key) => key !== 'pos' && key !== 'pos.fiscal');
    expect(body.features.map((f) => f.key)).toEqual(enabled);
    expect(body.features.find((f) => f.key === 'inventory')?.limits).toEqual({
      maxLocations: null,
    });
    expect(body.features.find((f) => f.key === 'api.public')?.limits).toEqual({
      requestsPerMinute: 120,
    });
    expect(body.features.find((f) => f.key === 'reports')?.limits).toEqual({});

    expect(await activeFeatures(token)).toEqual(enabled);
  });

  it('is empty for a plan that enables nothing and for a token without organization', async () => {
    const org = await seed.org();
    await emptyPlanFor(org.id);
    const user = await seed.user();
    await seed.member(org.id, user, org.roles.owner);
    expect(await entitlements(await seed.token(user, org.id))).toEqual({
      plan: { key: EMPTY_TEST_PLAN },
      features: [],
    });

    const noOrg = await seed.token(user, null);
    expect(await entitlements(noOrg)).toEqual({ plan: null, features: [] });
    expect(await activeFeatures(noOrg)).toEqual([]);
  });

  it('shows only the active organization, never another one the user belongs to', async () => {
    const a = await seed.org('A');
    const b = await seed.org('B');
    const user = await seed.user();
    await seed.member(a.id, user, a.roles.owner);
    await seed.member(b.id, user, b.roles.owner);
    await admin.setPlan(a.id, 'inventory', ACTOR);
    await admin.setPlan(b.id, 'full', ACTOR);

    const inA = await entitlements(await seed.token(user, a.id));
    expect(inA.plan).toEqual({ key: 'inventory' });
    expect(inA.features.map((f) => f.key)).toEqual([
      'inventory',
      'inventory.counts',
      'inventory.purchasing',
      'reports',
    ]);
    expect((await entitlements(await seed.token(user, b.id))).plan).toEqual({ key: 'full' });
  });

  it('reveals nothing to a non-member, even with a token naming the organization', async () => {
    const org = await seed.org();
    await admin.setPlan(org.id, 'full', ACTOR);
    const outsider = await seed.user();
    // A token for an organization the user isn't (or is no longer) a member of.
    const token = await seed.token(outsider, org.id);
    expect(await entitlements(token)).toEqual({ plan: null, features: [] });
  });

  it('needs a valid token', async () => {
    await request(server).get('/api/v1/me/entitlements').expect(401);
  });
});
