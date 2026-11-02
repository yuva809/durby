import { Prisma, type PrismaClient } from '../database/generated/client';
import type { TenantContext } from './tenant-context';
import { AUTH_PRIVATE_MODELS, STAFF_PRIVATE_MODELS, TENANT_MODELS } from './tenant-models';

export const TENANT_PRISMA = Symbol('TENANT_PRISMA');
export const PLATFORM_PRISMA = Symbol('PLATFORM_PRISMA');

export type TenantTransactionClient = Prisma.TransactionClient;

export class TenantModelOnPlatformClientError extends Error {
  readonly code = 'tenancy.tenant_model_on_platform_client';

  constructor(model: string) {
    super(
      `${model} is tenant-scoped: use the tenant client (TENANT_PRISMA), not the platform client.`,
    );
    this.name = 'TenantModelOnPlatformClientError';
  }
}

export class AuthPrivateModelOnPlatformClientError extends Error {
  readonly code = 'tenancy.auth_private_model_on_platform_client';

  constructor(model: string) {
    super(`${model} is private to platform/auth: use its public API, not the platform client.`);
    this.name = 'AuthPrivateModelOnPlatformClientError';
  }
}

export class StaffPrivateModelOnPlatformClientError extends Error {
  readonly code = 'tenancy.staff_private_model_on_platform_client';

  constructor(model: string) {
    super(`${model} is private to platform/staff: use its public API, not the platform client.`);
    this.name = 'StaffPrivateModelOnPlatformClientError';
  }
}

/**
 * The longest a tenant transaction waits for a row lock (ADR 0021): past it Postgres fails the
 * statement (55P03) and the api answers 503 platform.busy. Below PRISMA_TX_TIMEOUT_MS, which
 * doesn't interrupt a lock wait. A module may set a shorter one for its own writes.
 */
export const TENANT_LOCK_TIMEOUT = '4s';

/**
 * Sets the tenant and the lock timeout in one statement. `is_local = true`: both end with the
 * transaction, so they never leak to the next pool user.
 */
function setTenant(
  client: PrismaClient | TenantTransactionClient,
  tenantId: string,
): Prisma.PrismaPromise<number> {
  return client.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('lock_timeout', ${TENANT_LOCK_TIMEOUT}, true)`;
}

/**
 * Client for tenant tables. Every model call and raw query runs in its own transaction that first
 * sets `app.tenant_id`, so Postgres RLS (ADR 0005) applies. Throws TenantContextMissingError
 * without a tenant context. Multi-statement work uses `$transaction(fn)`: one transaction, tenant
 * set once, `fn` gets the transaction client.
 */
export function createTenantPrismaClient(base: PrismaClient, context: TenantContext) {
  return base.$extends({
    name: 'durby-tenant',
    client: {
      async $transaction<T>(
        fn: (tx: TenantTransactionClient) => Promise<T>,
        options?: {
          maxWait?: number;
          timeout?: number;
          isolationLevel?: Prisma.TransactionIsolationLevel;
        },
      ): Promise<T> {
        const { tenantId } = context.require();
        return base.$transaction(async (tx) => {
          await setTenant(tx, tenantId);
          return fn(tx);
        }, options);
      },
    },
    query: {
      async $allOperations({ args, query }) {
        const { tenantId } = context.require();
        const [, result] = await base.$transaction([
          setTenant(base, tenantId),
          query(args) as Prisma.PrismaPromise<unknown>,
        ]);
        return result;
      },
    },
  });
}

/**
 * Client for platform tables (partners, organizations, …). Rejects tenant models, auth-private
 * models (users, tokens) and staff-private models (ADR 0017) outright; raw
 * queries on tenant tables see no rows, since no tenant is set (fail closed).
 */
export function createPlatformPrismaClient(base: PrismaClient) {
  return base.$extends({
    name: 'durby-platform',
    query: {
      $allModels: {
        $allOperations({ model, args, query }) {
          if (TENANT_MODELS.has(model)) throw new TenantModelOnPlatformClientError(model);
          if (AUTH_PRIVATE_MODELS.has(model))
            throw new AuthPrivateModelOnPlatformClientError(model);
          if (STAFF_PRIVATE_MODELS.has(model))
            throw new StaffPrivateModelOnPlatformClientError(model);
          return query(args);
        },
      },
    },
  });
}

export type TenantPrismaClient = ReturnType<typeof createTenantPrismaClient>;
export type PlatformPrismaClient = ReturnType<typeof createPlatformPrismaClient>;
