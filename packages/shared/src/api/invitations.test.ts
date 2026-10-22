import { describe, expect, it } from 'vitest';
import { acceptInvitationRequestSchema, createInvitationRequestSchema } from './invitations';

describe('invitation schemas', () => {
  it('normalizes the invited email', () => {
    const body = createInvitationRequestSchema.parse({
      email: ' New.Cook@Example.TEST ',
      roleId: '01a165d1-ff82-7d5e-8d25-abf61bd10091',
    });
    expect(body.email).toBe('new.cook@example.test');
  });

  it('applies the password policy on accept', () => {
    expect(acceptInvitationRequestSchema.safeParse({ token: 't', password: 'short' }).success).toBe(
      false,
    );
    expect(
      acceptInvitationRequestSchema.safeParse({ token: 't', password: 'x'.repeat(12) }).success,
    ).toBe(true);
  });
});
