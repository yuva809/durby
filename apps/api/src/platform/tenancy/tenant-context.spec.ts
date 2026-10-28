import { CLS_REQ, ClsModule, ClsService } from 'nestjs-cls';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { beforeAll, describe, expect, it } from 'vitest';
import { TenantContext, TenantContextMissingError } from './tenant-context';
import { TENANT_MODELS } from './tenant-models';

describe('TenantContext', () => {
  let context: TenantContext;
  let cls: ClsService;
  const ctx = { tenantId: uuidv7(), userId: uuidv7() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [TenantContext],
    }).compile();
    context = moduleRef.get(TenantContext);
    cls = moduleRef.get(ClsService);
  });

  it('has no context outside a scope', () => {
    expect(context.get()).toBeUndefined();
    expect(() => context.require()).toThrow(TenantContextMissingError);
  });

  it('exposes the context inside run() and drops it afterwards', async () => {
    const seen = await context.run(ctx, () => Promise.resolve(context.require()));
    expect(seen).toEqual(ctx);
    expect(context.get()).toBeUndefined();
  });

  it('resolves lazy thenables (like Prisma queries) inside the scope', async () => {
    const lazy = { then: (resolve: (v: unknown) => void) => resolve(context.get()?.tenantId) };
    expect(await context.run(ctx, () => lazy as PromiseLike<unknown>)).toBe(ctx.tenantId);
  });

  it('keeps parallel scopes apart', async () => {
    const other = { tenantId: uuidv7(), userId: uuidv7() };
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
    const [a, b] = await Promise.all([
      context.run(ctx, async () => (await tick(), context.require().tenantId)),
      context.run(other, async () => (await tick(), context.require().tenantId)),
    ]);
    expect([a, b]).toEqual([ctx.tenantId, other.tenantId]);
  });

  it('nested run() overrides the outer tenant', async () => {
    const inner = { tenantId: uuidv7(), userId: uuidv7() };
    const seen = await context.run(ctx, () =>
      context.run(inner, () => Promise.resolve(context.require())),
    );
    expect(seen.tenantId).toBe(inner.tenantId);
  });

  it('carries the HTTP request into run(), and nothing else from the caller', async () => {
    const req = { id: 'req-1', ip: '203.0.113.7' };
    const seen = await cls.run(async () => {
      cls.set(CLS_REQ, req);
      cls.set('durby:access', { cached: true });
      return context.run(ctx, () =>
        Promise.resolve([cls.get<unknown>(CLS_REQ), cls.get<unknown>('durby:access')]),
      );
    });
    expect(seen).toEqual([req, undefined]);
  });

  it('rejects ids that are not UUIDs', () => {
    expect(() =>
      context.run({ tenantId: "x' OR 1=1", userId: uuidv7() }, () => Promise.resolve(1)),
    ).toThrow();
    expect(() => context.run({ ...ctx, locationId: 'nope' }, () => Promise.resolve(1))).toThrow();
  });

  it('the stored context is immutable', async () => {
    const stored = await context.run(ctx, () => Promise.resolve(context.require()));
    expect(Object.isFrozen(stored)).toBe(true);
  });
});

describe('TENANT_MODELS', () => {
  it('lists exactly the models with a tenantId field', () => {
    expect([...TENANT_MODELS].sort()).toEqual([
      'AuditLog',
      'Brand',
      'DiningArea',
      'DiningTable',
      'IdempotencyKey',
      'Invitation',
      'InvitationLocation',
      'LabelOverride',
      'Location',
      'Membership',
      'MembershipLocation',
      'NumberSeries',
      'NumberSeriesCounter',
      'OutboxEvent',
      'PosKitchenTicket',
      'PosOrder',
      'PosOrderLine',
      'ProcessedEvent',
      'Product',
      'ProductCategory',
      'Role',
      'RolePermission',
      'SettingValue',
      'TenantFeatureOverride',
    ]);
  });
});
