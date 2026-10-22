import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';
import { ZodBody } from './zod-body.pipe';

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
