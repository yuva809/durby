import type { ExecutionContext } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '../tenancy';
import type { AccessTokenService } from './access-token.service';
import type { AuthContext } from './auth-context';
import { Authenticator } from './authenticator';
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
  const guard = new Authenticator(
    { verify: () => Promise.resolve(claims) } as unknown as AccessTokenService,
    { isRevoked } as unknown as RevocationService,
    authContext as unknown as AuthContext,
    tenantContext as unknown as TenantContext,
    new Clock(),
  );
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: 'Bearer aaa.bbb.ccc' } }),
    }),
  } as unknown as ExecutionContext;
  return { guard, context, tenantContext, authContext };
}

describe('Authenticator', () => {
  it('fails closed with 503 auth.unavailable when the revocation store is down', async () => {
    const { guard, context, tenantContext, authContext } = guardWith(() =>
      Promise.reject(new RevocationUnavailableError(new Error('ECONNREFUSED'))),
    );
    await expect(guard.authenticate(context)).rejects.toMatchObject({
      code: 'auth.unavailable',
      status: 503,
    });
    expect(authContext.set).not.toHaveBeenCalled();
    expect(tenantContext.set).not.toHaveBeenCalled();
  });

  it('sets both contexts from the verified claims', async () => {
    const { guard, context, tenantContext, authContext } = guardWith(() => Promise.resolve(false));
    await expect(guard.authenticate(context)).resolves.toBeUndefined();
    expect(authContext.set).toHaveBeenCalledWith({
      userId: claims.userId,
      organizationId: claims.organizationId,
      sessionId: claims.sessionId,
      passwordChangeRequired: false,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    });
    expect(tenantContext.set).toHaveBeenCalledWith({
      tenantId: claims.organizationId,
      userId: claims.userId,
    });
  });
});
