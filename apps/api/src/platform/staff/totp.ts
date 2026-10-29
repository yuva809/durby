import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second steps, 6 digits,
 * which every authenticator app supports (ADR 0017 §5).
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted on either side of now, for clock drift. */
const WINDOW = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding: the form authenticator apps expect. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits (RFC 4226 recommends the HMAC-SHA1 output size), base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpCode(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return binary.toString().padStart(TOTP_DIGITS, '0');
}

/**
 * The step `code` belongs to (now ± 1 step), or null. A step at or before `lastStep` is refused, so
 * a code works once even inside its window.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const current = Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
  const given = Buffer.from(code);
  let match: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    // Compare every candidate in constant time, even after a match.
    if (timingSafeEqual(Buffer.from(totpCode(key, step)), given) && match === null) match = step;
  }
  if (match === null || (lastStep !== null && match <= lastStep)) return null;
  return match;
}

/** Key URI for QR codes (Google Authenticator format, understood by all common apps). */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
