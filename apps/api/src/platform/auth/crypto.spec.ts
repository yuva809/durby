import { describe, expect, it } from 'vitest';
import { emailKey, generateToken, hashToken, normalizeEmail } from './crypto';

describe('auth crypto', () => {
  it('generates 32-byte base64url tokens that differ each time', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('hashes tokens to stable sha256 hex', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('normalizes emails by trimming and lower-casing', () => {
    expect(normalizeEmail('  Alice@Example.TEST ')).toBe('alice@example.test');
  });

  it('derives the same rate-limit key for every spelling of an email, without the email in it', () => {
    const key = emailKey('Alice@example.test');
    expect(emailKey(' alice@EXAMPLE.test')).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('alice');
  });
});
