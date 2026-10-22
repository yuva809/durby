import { createHash, randomBytes } from 'node:crypto';

/** Opaque secret for refresh, reset and verification tokens: 32 random bytes, base64url. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Storage form of a generated token. Tokens carry 256 bits of entropy, so a plain sha256 is safe
 * (no slow hash needed) and lets the database look them up by equality.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** How emails are stored and compared (users.email has a CHECK for this form). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Key for per-email rate limits and lockout: the same for known and unknown emails, no PII in Redis. */
export function emailKey(email: string): string {
  return createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');
}
