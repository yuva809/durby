import { z } from 'zod';
import { generateToken, hashToken } from '../auth';

const organizationId = z.uuid();
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * A new invitation token `<organization id>.<secret>` and the hash to store (ADR 0007). The
 * organization id tells the accept endpoints which tenant to look in; only the secret's hash is
 * stored, and the organization is trusted only once that hash matched under RLS.
 */
export function issueInvitationToken(orgId: string): { token: string; hash: string } {
  const secret = generateToken();
  return { token: `${orgId}.${secret}`, hash: hashToken(secret) };
}

/** The organization id and secret hash of a well-formed token, else null (→ auth.token_invalid). */
export function parseInvitationToken(
  token: string,
): { organizationId: string; hash: string } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const org = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!organizationId.safeParse(org).success || !SECRET.test(secret)) return null;
  return { organizationId: org.toLowerCase(), hash: hashToken(secret) };
}
