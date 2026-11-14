/**
 * White-label theme (docs/platform/web-shell.md → Design system, ADR 0015). A partner supplies a
 * primary color and optionally ink (text) and paper (background); every other token is derived
 * here so that text pairs reach WCAG AA (4.5:1) and non-text pairs (focus ring, input borders) 3:1.
 */

/** `#rrggbb`, lowercase: the only color form stored, sent and rendered. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Static logo files committed under apps/web/public/brand/<partner-slug>/ (ADR 0015 §4). */
export const LOGO_PATH = /^\/brand\/[a-z0-9-]+\/[a-z0-9-]+\.(svg|png|webp)$/;

export const PRODUCT_NAME_MAX_LENGTH = 60;

export const AA_TEXT = 4.5;
export const AA_NON_TEXT = 3;

export const THEME_TOKEN_NAMES = [
  'background',
  'foreground',
  'card',
  'muted',
  'mutedForeground',
  'border',
  'input',
  'primary',
  'primaryForeground',
  'primaryText',
  'ring',
  'destructive',
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

export interface ThemeColors {
  primary: string;
  ink?: string | null;
  paper?: string | null;
}

/** Durby's brand palette: Ink, Ember, Paper. */
export const DEFAULT_COLORS = { primary: '#ff5a1f', ink: '#17140f', paper: '#fbf8f3' } as const;

const WHITE = '#ffffff';
const BLACK = '#000000';
const DESTRUCTIVE = '#b42318';
const MIX_STEP = 0.02;

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Relative luminance (WCAG 2.x). */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `from` moved `t` (0–1) of the way toward `to`, in sRGB, rounded to a hex color. */
export function mix(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  return toHex(a.map((c, i) => c + ((b[i] ?? c) - c) * t));
}

/**
 * The color closest to `from` on the way to `to` that reaches `min` against every surface, or
 * `to` itself. Checked on the rounded hex, which is what the browser renders.
 */
function firstReaching(from: string, to: string, surfaces: string[], min: number): string {
  for (let step = 0; step * MIX_STEP < 1; step += 1) {
    const color = mix(from, to, step * MIX_STEP);
    if (surfaces.every((s) => contrastRatio(color, s) >= min)) return color;
  }
  return to;
}

function readableOn(background: string, ink: string): string {
  const best =
    [ink, WHITE].sort((a, b) => contrastRatio(b, background) - contrastRatio(a, background))[0] ??
    ink;
  // Black or white always reaches 4.5:1 on some side; a dark ink that isn't black may not.
  if (contrastRatio(best, background) >= AA_TEXT) return best;
  return contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE;
}

/**
 * Every token from three colors, or null if `ink` can't carry text on `paper` (and on cards and
 * muted fills) at AA. Callers then fall back to the default ink and paper (`resolveThemeColors`).
 */
export function deriveThemeTokens(colors: ThemeColors): ThemeTokens | null {
  const ink = colors.ink ?? DEFAULT_COLORS.ink;
  const paper = colors.paper ?? DEFAULT_COLORS.paper;
  const { primary } = colors;
  if (![primary, ink, paper].every((c) => HEX_COLOR.test(c))) return null;

  const card = WHITE;
  const muted = mix(paper, ink, 0.05);
  const textSurfaces = [paper, card, muted];
  if (!textSurfaces.every((s) => contrastRatio(ink, s) >= AA_TEXT)) return null;

  const primaryText = firstReaching(primary, ink, textSurfaces, AA_TEXT);
  return {
    background: paper,
    foreground: ink,
    card,
    muted,
    mutedForeground: firstReaching(mix(paper, ink, 0.4), ink, textSurfaces, AA_TEXT),
    border: mix(paper, ink, 0.12),
    input: firstReaching(mix(paper, ink, 0.3), ink, [paper, card], AA_NON_TEXT),
    primary,
    primaryForeground: readableOn(primary, ink),
    primaryText,
    ring: primaryText,
    destructive: firstReaching(DESTRUCTIVE, ink, textSurfaces, AA_TEXT),
  };
}

/**
 * Tokens for a partner's colors; if its ink and paper can't reach AA, the default ink and paper
 * with its primary (`fallback: true`, logged by the api as `theme.contrast_fallback`).
 */
export function resolveThemeColors(colors: ThemeColors): {
  tokens: ThemeTokens;
  fallback: boolean;
} {
  const tokens = deriveThemeTokens(colors);
  if (tokens) return { tokens, fallback: false };
  const primary = HEX_COLOR.test(colors.primary) ? colors.primary : DEFAULT_COLORS.primary;
  return {
    tokens: deriveThemeTokens({ ...DEFAULT_COLORS, primary }) ?? DEFAULT_TOKENS,
    fallback: true,
  };
}

const DEFAULT_TOKENS = deriveThemeTokens(DEFAULT_COLORS) as ThemeTokens;

/**
 * The theme for unknown hosts and partners without a theme, and the web app's fallback when the
 * api is unreachable. Durby is the default partner (ARCHITECTURE.md → Tenancy model).
 */
export const DEFAULT_THEME = {
  productName: 'Durby',
  logoUrl: null,
  tokens: DEFAULT_TOKENS,
  navLayout: 'default',
} as const satisfies {
  productName: string;
  logoUrl: string | null;
  tokens: ThemeTokens;
  navLayout: NavLayout;
};

/**
 * Sidebar layouts a partner theme can pick (ADR 0044): `default` is Durby's menu, `operations` the
 * grouped menu of a distribution business (Business operations, Administration, Tools). Same shape as
 * `partner_themes_nav_layout_check`.
 */
export const NAV_LAYOUTS = ['default', 'operations'] as const;

export type NavLayout = (typeof NAV_LAYOUTS)[number];

const HOST_LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
/** Same shape as the `partner_domains_hostname_check` constraint. */
export const HOSTNAME = new RegExp(`^(${HOST_LABEL}\\.)+${HOST_LABEL}$`);
export const HOSTNAME_MAX_LENGTH = 253;

/**
 * A request's host in the form `partner_domains` stores (lowercase, no port, no trailing dot), or
 * null for anything that can't be a partner domain: empty, IP literals, malformed or oversized.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[')) return null; // IPv6 literal
  const port = /:(\d{1,5})$/.exec(host);
  if (port) host = host.slice(0, port.index);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > HOSTNAME_MAX_LENGTH || !HOSTNAME.test(host)) return null;
  if (/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1))) return null; // IPv4 literal
  return host;
}
