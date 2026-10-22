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
