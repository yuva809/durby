/**
 * The `next` query parameter of /login as a same-origin path, or `/`. Anything that could leave
 * the origin (`//host`, `/\host`, `https:`, control characters) is refused: no open redirect.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  return raw;
}

/** /login with the current path as `next` (the guard's redirect target). */
export function loginPath(currentPath: string): string {
  return currentPath === '/' ? '/login' : `/login?next=${encodeURIComponent(currentPath)}`;
}
