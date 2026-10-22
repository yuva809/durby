import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

export const tenantContextSchema = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  locationId: z.uuid().optional(),
});

export type TenantContextValue = Readonly<z.infer<typeof tenantContextSchema>>;

const CLS_KEY = 'durby:tenant';

/** Thrown when tenant-scoped work runs outside a tenant context. Never caught to "fall back". */
export class TenantContextMissingError extends Error {
  readonly code = 'tenancy.context_missing';

  constructor() {
    super(
      'No tenant context: tenant-scoped data needs an authenticated tenant (or TenantContext.run).',
    );
    this.name = 'TenantContextMissingError';
  }
}

/**
 * The tenant of the current request or job, held in AsyncLocalStorage (nestjs-cls).
 * Filled only from the authenticated session (step 1.2) or explicitly via run(), never
 * from request body, query or headers (CLAUDE.md hard rule 1).
 */
@Injectable()
export class TenantContext {
  constructor(private readonly cls: ClsService) {}

  get(): TenantContextValue | undefined {
    return this.cls.isActive() ? this.cls.get<TenantContextValue | undefined>(CLS_KEY) : undefined;
  }

  require(): TenantContextValue {
    const ctx = this.get();
    if (!ctx) throw new TenantContextMissingError();
    return ctx;
  }

  /** Sets the context for the active CLS scope (the HTTP request). Used by the auth guard. */
  set(ctx: TenantContextValue): void {
    this.cls.set(CLS_KEY, Object.freeze(tenantContextSchema.parse(ctx)));
  }

  /**
   * Runs `fn` in a fresh scope bound to `ctx` (jobs, scripts, tests). The result is awaited inside
   * the scope: Prisma queries are lazy thenables that only execute when awaited, so returning one
   * unawaited would run it after the scope has ended.
   */
  run<T>(ctx: TenantContextValue, fn: () => PromiseLike<T>): Promise<T> {
    const value = Object.freeze(tenantContextSchema.parse(ctx));
    return this.cls.run({ ifNested: 'override' }, async () => {
      this.cls.set(CLS_KEY, value);
      return await fn();
    });
  }
}
