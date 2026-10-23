import {
  DEFAULT_THEME,
  HEX_COLOR,
  THEME_TOKEN_NAMES,
  type ThemeResponse,
  themeResponseSchema,
  type ThemeTokenName,
} from '@durby/shared';
import { apiBaseUrl } from './api';

/** `mutedForeground` → `--muted-foreground` (the names in app/globals.css). */
export function tokenVariable(name: ThemeTokenName): string {
  return `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * The `:root` rule for a theme's tokens. Every value is checked again as `#rrggbb` (a bad value
 * falls back to the default token), so nothing but a color can reach the stylesheet.
 */
export function tokensCss(tokens: Readonly<Record<string, unknown>>): string {
  const declarations = THEME_TOKEN_NAMES.map((name) => {
    const value = tokens[name];
    const color =
      typeof value === 'string' && HEX_COLOR.test(value) ? value : DEFAULT_THEME.tokens[name];
    return `${tokenVariable(name)}:${color}`;
  });
  return `:root{${declarations.join(';')}}`;
}

/**
 * The theme for the request's host (docs/platform/web-shell.md → Resolution): asks the api
 * directly with `X-Forwarded-Host`, never cached by Next (the response depends on the host).
 * The default theme if the api is unreachable or answers unexpectedly.
 */
export async function fetchTheme(
  host: string | null,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = apiBaseUrl(),
): Promise<ThemeResponse> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/theme`, {
      cache: 'no-store',
      headers: host ? { 'X-Forwarded-Host': host } : {},
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return DEFAULT_THEME;
    const parsed = themeResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}
