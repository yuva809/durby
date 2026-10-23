import {
  DEFAULT_THEME,
  normalizeHost,
  resolveThemeColors,
  type ThemeResponse,
} from '@durby/shared';

/** One `partner_domains` row with its partner's theme (null: the partner has none). */
export interface DomainThemeRow {
  hostname: string;
  partnerId: string;
  theme: {
    productName: string;
    logoPath: string | null;
    colorPrimary: string;
    colorInk: string | null;
    colorPaper: string | null;
  } | null;
}

/** Hostname → theme. Hosts not in the map get DEFAULT_THEME (one shared object). */
export type ThemeSnapshot = ReadonlyMap<string, ThemeResponse>;

/**
 * Builds the snapshot from every domain row. Partners whose ink and paper miss AA get the default
 * ink and paper; `onContrastFallback` reports them once per partner.
 */
export function buildThemeSnapshot(
  rows: readonly DomainThemeRow[],
  onContrastFallback: (partnerId: string) => void = () => undefined,
): ThemeSnapshot {
  const byPartner = new Map<string, ThemeResponse>();
  const snapshot = new Map<string, ThemeResponse>();
  for (const row of rows) {
    let theme = byPartner.get(row.partnerId);
    if (!theme) {
      theme = row.theme ? toResponse(row.partnerId, row.theme, onContrastFallback) : DEFAULT_THEME;
      byPartner.set(row.partnerId, theme);
    }
    snapshot.set(row.hostname, theme);
  }
  return snapshot;
}

function toResponse(
  partnerId: string,
  theme: NonNullable<DomainThemeRow['theme']>,
  onContrastFallback: (partnerId: string) => void,
): ThemeResponse {
  const { tokens, fallback } = resolveThemeColors({
    primary: theme.colorPrimary,
    ink: theme.colorInk,
    paper: theme.colorPaper,
  });
  if (fallback) onContrastFallback(partnerId);
  return { productName: theme.productName, logoUrl: theme.logoPath, tokens };
}

/** The theme for a raw request host; unknown, malformed and IP hosts get DEFAULT_THEME. */
export function themeForHost(snapshot: ThemeSnapshot, rawHost: string | undefined): ThemeResponse {
  const host = normalizeHost(rawHost);
  return (host === null ? undefined : snapshot.get(host)) ?? DEFAULT_THEME;
}
