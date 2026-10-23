import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';
import { ZodBody, ZodQuery } from './zod-body.pipe';

const schema = z.object({ email: z.email(), password: z.string().min(12) });

describe('ZodBody', () => {
  const pipe = new ZodBody(schema);

  it('returns the parsed body', () => {
    expect(pipe.transform({ email: 'a@b.test', password: 'long-enough-pw' })).toEqual({
      email: 'a@b.test',
      password: 'long-enough-pw',
    });
  });

  it('throws 400 validation.failed with issues but never the input values', () => {
    const secret = 'short-pw';
    let error: unknown;
    try {
      pipe.transform({ email: 'not-an-email', password: secret });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.getStatus()).toBe(400);
    expect(apiError.body()).toMatchObject({
      code: 'validation.failed',
      details: { issues: [{ path: 'email' }, { path: 'password', code: 'too_small' }] },
    });
    expect(JSON.stringify(apiError.body())).not.toContain(secret);
    expect(JSON.stringify(apiError.body())).not.toContain('not-an-email');
  });
});

describe('ZodQuery', () => {
  const pipe = new ZodQuery(z.object({ limit: z.coerce.number().int().max(10) }));

  it('returns the parsed query', () => {
    expect(pipe.transform({ limit: '5' })).toEqual({ limit: 5 });
  });

  it('throws 400 validation.failed for the query', () => {
    expect(() => pipe.transform({ limit: '11' })).toThrow(ApiError);
    try {
      pipe.transform({ limit: '11' });
    } catch (e) {
      expect((e as ApiError).body()).toMatchObject({
        code: 'validation.failed',
        message: 'Invalid query.',
      });
    }
  });
});
