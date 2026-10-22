import { type ArgumentsHost, Logger, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TenantContextMissingError } from '../tenancy';
import { ApiError } from './api-error';
import { ApiExceptionFilter } from './api-exception.filter';

function run(exception: unknown) {
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new ApiExceptionFilter().catch(exception, host);
  return {
    status: res.status.mock.calls[0]?.[0] as number,
    body: res.json.mock.calls[0]?.[0] as unknown,
    headers: Object.fromEntries(res.setHeader.mock.calls as [string, string][]),
  };
}

describe('ApiExceptionFilter', () => {
  it('passes ApiError through with its headers', () => {
    const out = run(
      new ApiError(429, 'auth.rate_limited', 'Slow down', undefined, { 'Retry-After': '30' }),
    );
    expect(out).toEqual({
      status: 429,
      body: { code: 'auth.rate_limited', message: 'Slow down' },
      headers: { 'Retry-After': '30' },
    });
  });

  it('maps a missing tenant context to 403 tenancy.context_missing', () => {
    expect(run(new TenantContextMissingError())).toMatchObject({
      status: 403,
      body: { code: 'tenancy.context_missing' },
    });
  });

  it('gives Nest HTTP errors a stable code', () => {
    expect(run(new NotFoundException())).toMatchObject({
      status: 404,
      body: { code: 'http.not_found' },
    });
  });

  it('hides the message of unexpected errors from the client and the log', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const out = run(new Error('duplicate key value (email)=(alice@example.test)'));
    expect(out).toMatchObject({ status: 500, body: { code: 'internal.error' } });
    expect(JSON.stringify(out.body)).not.toContain('alice');
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('alice');
    log.mockRestore();
  });
});
