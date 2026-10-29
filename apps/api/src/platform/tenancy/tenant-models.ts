import { Prisma } from '../database/generated/client';

/**
 * Models with a `tenantId` field, read from the generated client so new tenant models are
 * picked up without a list to maintain. Their tables must have RLS (test/rls-coverage.int.spec.ts).
 */
export const TENANT_MODELS: ReadonlySet<Prisma.ModelName> = new Set(
  Object.values(Prisma.ModelName).filter((model) => {
    const fields = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[
      `${model}ScalarFieldEnum`
    ];
    if (!fields) throw new Error(`Generated client has no ${model}ScalarFieldEnum`);
    return 'tenantId' in fields;
  }),
);

/**
 * Platform models private to platform/auth (ADR 0006): password and token hashes. The platform
 * client refuses them like tenant models; platform/auth reads them through PrismaService.
 */
export const AUTH_PRIVATE_MODELS: ReadonlySet<Prisma.ModelName> = new Set<Prisma.ModelName>([
  'User',
  'UserToken',
  'RefreshToken',
]);

/**
 * Platform models private to platform/staff (ADR 0017 §1): staff credentials, sessions and the
 * platform audit log. The platform client refuses them too.
 */
export const STAFF_PRIVATE_MODELS: ReadonlySet<Prisma.ModelName> = new Set<Prisma.ModelName>([
  'StaffAccount',
  'StaffToken',
  'StaffSession',
  'PlatformAuditLog',
  'StaffIdempotencyKey',
]);
