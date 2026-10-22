import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config';
import { ApiError } from '../http';
import { OriginGuard } from './origin.guard';

const guard = new OriginGuard({
  WEB_ORIGINS: ['https://app.durby.test', 'http://localhost:3000'],
} as AppConfig);

const withOrigin = (origin?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: origin ? { origin } : {} }) }),
  }) as unknown as ExecutionContext;

describe('OriginGuard', () => {
  it('accepts an allowed origin', () => {
    expect(guard.canActivate(withOrigin('https://app.durby.test'))).toBe(true);
    expect(guard.canActivate(withOrigin('http://localhost:3000'))).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['foreign', 'https://evil.test'],
    ['lookalike', 'https://app.durby.test.evil.test'],
    ['other scheme', 'http://app.durby.test'],
    ['other port', 'http://localhost:3001'],
    ['null (sandboxed iframe, file://)', 'null'],
  ])('rejects a %s origin with 403 auth.origin_rejected', (_, origin) => {
    let error: unknown;
    try {
      guard.canActivate(withOrigin(origin));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).getStatus()).toBe(403);
    expect((error as ApiError).code).toBe('auth.origin_rejected');
  });
});
