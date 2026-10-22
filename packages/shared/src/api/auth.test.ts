import { describe, expect, it } from 'vitest';
import { emailRequestSchema, loginRequestSchema, resetPasswordRequestSchema } from './auth';

describe('auth schemas', () => {
  it('normalizes emails before validating them', () => {
    expect(emailRequestSchema.parse({ email: '  Alice@Example.TEST ' })).toEqual({
      email: 'alice@example.test',
    });
    expect(emailRequestSchema.safeParse({ email: 'not an email' }).success).toBe(false);
  });

  it('checks login passwords only for length bounds', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.test', password: 'x' }).success).toBe(true);
    expect(
      loginRequestSchema.safeParse({ email: 'a@b.test', password: 'x'.repeat(129) }).success,
    ).toBe(false);
  });

  it('applies the password policy (12-128) on reset and requires a well-formed token', () => {
    const token = 'A'.repeat(43);
    expect(resetPasswordRequestSchema.safeParse({ token, password: 'x'.repeat(11) }).success).toBe(
      false,
    );
    expect(resetPasswordRequestSchema.safeParse({ token, password: 'x'.repeat(12) }).success).toBe(
      true,
    );
    expect(
      resetPasswordRequestSchema.safeParse({ token: 'short', password: 'x'.repeat(12) }).success,
    ).toBe(false);
  });
});
