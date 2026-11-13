/**
 * Base URL of links in emails (docs/platform/web-shell.md → Invitation links, ADR 0015 §12, ADR 0041): the first
 * allowed web origin whose hostname is one of the organization's partner domains, else `fallback` (WEB_BASE_URL).
 * Never the request's Host, so a client can't put a host into an email.
 */
export function inviteLinkBase(
  origins: readonly string[],
  fallback: string,
  partnerHostnames: readonly string[],
): string {
  const hostnames = new Set(partnerHostnames.map((h) => h.toLowerCase()));
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (hostnames.has(url.hostname)) return url.origin;
  }
  return fallback;
}

/** Where a user-level email's link points (ADR 0041). */
export interface MailLinkTarget {
  /** The organization's partner domains (onboarding: create-admin, admin portal). */
  partnerHostnames?: readonly string[];
  /**
   * The `Origin` of the browser request that asked for the mail (forgot password, resend verification). Used only
   * when it is exactly one of the allowed web origins: a client can pick among our own sites, never add one.
   */
  requestOrigin?: string;
}

/** Partner domains first, then an allowed request origin, else `fallback` (WEB_BASE_URL). */
export function mailLinkBase(
  origins: readonly string[],
  fallback: string,
  target: MailLinkTarget = {},
): string {
  if (target.partnerHostnames && target.partnerHostnames.length > 0) {
    return inviteLinkBase(origins, fallback, target.partnerHostnames);
  }
  if (target.requestOrigin !== undefined && origins.includes(target.requestOrigin)) {
    return target.requestOrigin;
  }
  return fallback;
}
