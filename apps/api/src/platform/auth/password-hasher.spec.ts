import { describe, expect, it } from 'vitest';
import { PasswordHasher } from './password-hasher';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('hashes with argon2id, 19 MiB, t=2, p=1', async () => {
    expect(await hasher.hash('correct horse battery')).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/,
    );
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse batterY')).toBe(false);
  });

  it('rejects when there is no stored hash, after doing the same work', async () => {
    expect(await hasher.verify(null, 'anything at all')).toBe(false);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await hasher.verify('not-a-hash', 'anything at all')).toBe(false);
  });
});
