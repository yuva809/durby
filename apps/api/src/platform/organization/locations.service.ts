import { Inject, Injectable } from '@nestjs/common';
import type { LocationSummary } from '@durby/shared';
import { auditActor, AuditService, snapshot } from '../audit';
import { IdempotencyService } from '../idempotency';
import {
  TENANT_PRISMA,
  TenantContext,
  type TenantPrismaClient,
  type TenantTransactionClient as Tx,
} from '../tenancy';
import { isForeignKeyViolation, locationErrors } from './location-errors';

const LOCATION_SELECT = { id: true, brandId: true, name: true } as const;

/**
 * The organization's locations (docs/platform/web-shell.md → Locations). Names are unique per
 * organization (case-insensitive), checked under a per-organization transaction lock. A location
 * is deleted only while nothing points at it: every reference is a `RESTRICT` foreign key, so the
 * database says "in use" and this platform code never looks at module tables.
 */
@Injectable()
export class LocationsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** The organization's first location also creates its brand, named after the organization. */
  create(name: string): Promise<LocationSummary> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      await lockLocations(tx, tenantId);
      await assertNameFree(tx, name);
      const brandId = (await firstBrand(tx)) ?? (await createBrand(tx, tenantId));
      const row = await tx.location.create({
        data: { tenantId, brandId, name },
        select: LOCATION_SELECT,
      });
      await this.audit.record(tx, {
        action: 'platform.location.created',
        actor: auditActor.user(userId),
        entityId: row.id,
        after: snapshot('location', row),
      });
      await this.idempotency.completeInTransaction(tx, row);
      return row;
    });
  }

  /** Same name again writes nothing. */
  rename(id: string, name: string): Promise<LocationSummary> {
    const { tenantId, userId } = this.tenantContext.require();
    return this.db.$transaction(async (tx) => {
      await lockLocations(tx, tenantId);
      const before = await tx.location.findUnique({ where: { id }, select: LOCATION_SELECT });
      if (!before) throw locationErrors.notFound();
      if (before.name === name) return before;
      await assertNameFree(tx, name, id);
      const after = await tx.location.update({
        where: { id },
        data: { name },
        select: LOCATION_SELECT,
      });
      await this.audit.record(tx, {
        action: 'platform.location.updated',
        actor: auditActor.user(userId),
        entityId: id,
        before: snapshot('location', before),
        after: snapshot('location', after),
      });
      return after;
    });
  }

  async remove(id: string): Promise<void> {
    const { userId } = this.tenantContext.require();
    try {
      await this.db.$transaction(async (tx) => {
        const before = await tx.location.findUnique({ where: { id }, select: LOCATION_SELECT });
        if (!before) throw locationErrors.notFound();
        await tx.location.delete({ where: { id } });
        await this.audit.record(tx, {
          action: 'platform.location.deleted',
          actor: auditActor.user(userId),
          entityId: id,
          before: snapshot('location', before),
        });
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw locationErrors.inUse();
      throw error;
    }
  }
}

/** Serializes location writes of one organization, so two creates can't both take a free name. */
async function lockLocations(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`locations:${tenantId}`}, 0))`;
}

async function assertNameFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
  const taken = await tx.location.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (taken) throw locationErrors.nameTaken();
}

async function firstBrand(tx: Tx): Promise<string | null> {
  const brand = await tx.brand.findFirst({ select: { id: true }, orderBy: { id: 'asc' } });
  return brand?.id ?? null;
}

async function createBrand(tx: Tx, tenantId: string): Promise<string> {
  const org = await tx.organization.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true },
  });
  const brand = await tx.brand.create({
    data: { tenantId, name: org.name },
    select: { id: true },
  });
  return brand.id;
}
