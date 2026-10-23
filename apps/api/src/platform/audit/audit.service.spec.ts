import { Test } from '@nestjs/testing';
import { CLS_REQ, ClsModule, ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import { beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../database/generated/client';
import { TenantContext, type TenantTransactionClient } from '../tenancy';
import { snapshot } from './audit-snapshots';
import { auditActor, AuditService } from './audit.service';
import { RequestInfo } from './request-info';

/** A transaction client that only records auditLog.create calls. */
function fakeTx() {
  const created: Record<string, unknown>[] = [];
  const tx = {
    auditLog: {
      create: (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: uuidv7() });
      },
    },
  } as unknown as TenantTransactionClient;
  return { tx, created };
}

describe('AuditService', () => {
  let audit: AuditService;
  let tenantContext: TenantContext;
  let cls: ClsService;
  const ctx = { tenantId: uuidv7(), userId: uuidv7() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [AuditService, RequestInfo, TenantContext],
    }).compile();
    audit = moduleRef.get(AuditService);
    tenantContext = moduleRef.get(TenantContext);
    cls = moduleRef.get(ClsService);
  });

  it('writes a user action with its entity type from the registry', async () => {
    const { tx, created } = fakeTx();
    const roleId = uuidv7();
    await tenantContext.run(ctx, () =>
      audit.record(tx, {
        action: 'platform.role.updated',
        actor: auditActor.user(ctx.userId),
        entityId: roleId,
        before: snapshot('role', { id: roleId, name: 'Old' }),
        after: snapshot('role', { id: roleId, name: 'New' }),
      }),
    );
    expect(created).toEqual([
      {
        tenantId: ctx.tenantId,
        actorType: 'user',
        actorUserId: ctx.userId,
        actorSystem: null,
        action: 'platform.role.updated',
        entityType: 'role',
        entityId: roleId,
        before: { id: roleId, name: 'Old' },
        after: { id: roleId, name: 'New' },
        requestId: null,
        ip: null,
      },
    ]);
  });

  it('writes a system actor and SQL NULL snapshots', async () => {
    const { tx, created } = fakeTx();
    await tenantContext.run(ctx, () =>
      audit.record(tx, {
        action: 'platform.organization.created',
        actor: auditActor.system('cli.create_admin'),
        entityId: ctx.tenantId,
      }),
    );
    expect(created[0]).toMatchObject({
      actorType: 'system',
      actorUserId: null,
      actorSystem: 'cli.create_admin',
      before: Prisma.DbNull,
      after: Prisma.DbNull,
    });
  });

  it('takes request id and client IP from the request in CLS', async () => {
    const { tx, created } = fakeTx();
    const record = (req: object) =>
      cls.run(async () => {
        cls.set(CLS_REQ, req);
        await tenantContext.run(ctx, () =>
          audit.record(tx, {
            action: 'platform.role.deleted',
            actor: auditActor.user(ctx.userId),
            entityId: ctx.tenantId,
          }),
        );
      });
    await record({ id: 'req-42', ip: '203.0.113.7' });
    await record({ id: 'x'.repeat(65), ip: 'not an ip' });
    expect(created.map((d) => [d.requestId, d.ip])).toEqual([
      ['req-42', '203.0.113.7'],
      [null, null],
    ]);
  });

  it('needs a tenant context', async () => {
    const { tx } = fakeTx();
    await expect(
      audit.record(tx, {
        action: 'platform.role.created',
        actor: auditActor.user(ctx.userId),
        entityId: ctx.tenantId,
      }),
    ).rejects.toThrow(/No tenant context/);
  });
});
