/**
 * Base URL of invitation links (docs/platform/web-shell.md → Invitation links, ADR 0015 §12): the
 * first allowed web origin whose hostname is one of the organization's partner domains, else
 * `fallback` (WEB_BASE_URL). Never the request's Host, so a client can't put a host into an email.
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
