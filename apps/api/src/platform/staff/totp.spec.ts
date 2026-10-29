import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  TOTP_STEP_SECONDS,
  totpCode,
  verifyTotp,
} from './totp';

// RFC 6238 Appendix B, SHA-1: the seed "12345678901234567890", 8 digits there; we use the last 6.
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

const at = (seconds: number) => new Date(seconds * 1000);

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('matches the RFC vector at %i s', (seconds, expected) => {
    expect(totpCode(RFC_SEED, Math.floor(seconds / TOTP_STEP_SECONDS))).toBe(expected.slice(-6));
  });

  it('round-trips base32 (RFC 4648, no padding) and generates 160-bit secrets', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb oi').toString()).toBe('foobar');
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('accepts the current, previous and next step, nothing further', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000;
    const step = Math.floor(now / TOTP_STEP_SECONDS);
    const code = (s: number) => totpCode(base32Decode(secret), s);
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotp(secret, code(step + offset), at(now), null)).toBe(step + offset);
    }
    expect(verifyTotp(secret, code(step - 2), at(now), null)).toBeNull();
    expect(verifyTotp(secret, code(step + 2), at(now), null)).toBeNull();
    expect(verifyTotp(secret, '000000', at(now), null)).toBeNull();
  });

  it('never accepts a step at or before the last used one (no replay)', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000;
    const step = Math.floor(now / TOTP_STEP_SECONDS);
    const code = totpCode(base32Decode(secret), step);
    expect(verifyTotp(secret, code, at(now), step)).toBeNull();
    expect(verifyTotp(secret, code, at(now), step - 1)).toBe(step);
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const uri = new URL(otpauthUri('ABCDEFGH', 'ops@durby.tech', 'Staff portal'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Staff portal:ops@durby.tech');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'ABCDEFGH',
      issuer: 'Staff portal',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
