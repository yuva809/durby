import {
  type ArgumentsHost,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
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

  it('answers a body over the parser limit with 413 platform.payload_too_large', () => {
    // What body-parser passes to next() (an http-errors object, not a Nest HttpException).
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
      length: 400_000,
      limit: 300_000,
    });
    expect(run(tooLarge)).toEqual({
      status: 413,
      body: { code: 'platform.payload_too_large', message: 'The request body is too large.' },
      headers: {},
    });
    expect(run(new PayloadTooLargeException())).toMatchObject({
      status: 413,
      body: { code: 'platform.payload_too_large' },
    });
  });

  it('keeps other parser-like errors a 500', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const other = Object.assign(new Error('x'), { status: 413, type: 'something.else' });
    expect(run(other)).toMatchObject({ status: 500, body: { code: 'internal.error' } });
    expect(run(Object.assign(new Error('x'), { type: 'entity.too.large' }))).toMatchObject({
      status: 500,
    });
    log.mockRestore();
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
