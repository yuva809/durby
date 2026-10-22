import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '../tenancy';
import type { AccessTokenService } from './access-token.service';
import type { AuthContext } from './auth-context';
import { AuthGuard } from './auth.guard';
import { Clock } from './clock';
import { type RevocationService, RevocationUnavailableError } from './revocation.service';

const claims = {
  userId: uuidv7(),
  organizationId: uuidv7(),
  sessionId: uuidv7(),
  issuedAt: 1,
  expiresAt: 2,
};

function guardWith(isRevoked: () => Promise<boolean>) {
  const tenantContext = { set: vi.fn() };
  const authContext = { set: vi.fn() };
  const guard = new AuthGuard(
    { getAllAndOverride: () => undefined } as unknown as Reflector,
    { verify: () => Promise.resolve(claims) } as unknown as AccessTokenService,
    { isRevoked } as unknown as RevocationService,
    authContext as unknown as AuthContext,
    tenantContext as unknown as TenantContext,
    new Clock(),
  );
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: 'Bearer aaa.bbb.ccc' } }),
    }),
  } as unknown as ExecutionContext;
  return { guard, context, tenantContext, authContext };
}

describe('AuthGuard', () => {
  it('fails closed with 503 auth.unavailable when the revocation store is down', async () => {
    const { guard, context, tenantContext, authContext } = guardWith(() =>
      Promise.reject(new RevocationUnavailableError(new Error('ECONNREFUSED'))),
    );
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'auth.unavailable',
      status: 503,
    });
    expect(authContext.set).not.toHaveBeenCalled();
    expect(tenantContext.set).not.toHaveBeenCalled();
  });

  it('sets both contexts from the verified claims', async () => {
    const { guard, context, tenantContext, authContext } = guardWith(() => Promise.resolve(false));
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authContext.set).toHaveBeenCalledWith({
      userId: claims.userId,
      organizationId: claims.organizationId,
      sessionId: claims.sessionId,
    });
    expect(tenantContext.set).toHaveBeenCalledWith({
      tenantId: claims.organizationId,
      userId: claims.userId,
    });
  });
});
