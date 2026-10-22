import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../auth';
import { issueInvitationToken, parseInvitationToken } from './invitation-token';

describe('invitation tokens', () => {
  it('round-trips the organization and stores only the hash of the secret', () => {
    const org = uuidv7();
    const { token, hash } = issueInvitationToken(org);
    expect(token).toMatch(new RegExp(`^${org}\\.[A-Za-z0-9_-]{43}$`));
    expect(hash).toBe(hashToken(token.slice(org.length + 1)));
    expect(parseInvitationToken(token)).toEqual({ organizationId: org, hash });
  });

  it.each([
    ['no separator', 'abc'],
    ['organization is not a uuid', `not-a-uuid.${'a'.repeat(43)}`],
    ['sql in the organization', `' OR 1=1 --.${'a'.repeat(43)}`],
    ['short secret', `${uuidv7()}.abc`],
    ['secret with dots', `${uuidv7()}.${'a'.repeat(42)}.`],
    ['empty', ''],
  ])('rejects a malformed token: %s', (_, token) => {
    expect(parseInvitationToken(token)).toBeNull();
  });
});
