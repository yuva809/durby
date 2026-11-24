import { ImageResponse } from 'next/og';
import type { ThemeResponse } from '@durby/shared';

/** Sizes of the home-screen icons in the manifest (ADR 0083). */
export const APP_ICON_SIZES = [192, 512] as const;

/**
 * The letter on the icon: the product name's first, if it is a plain one. Other characters would make the renderer
 * fetch a font from the internet, so they get none.
 */
export function appIconLetter(productName: string): string {
  const first = productName.trim().charAt(0).toUpperCase();
  return /^[A-Z0-9]$/.test(first) ? first : '';
}

/** A square icon in the partner's colors, drawn per request: a partner needs no image file for it. */
export function appIcon(theme: ThemeResponse, size: number): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: theme.tokens.primary,
        color: theme.tokens.primaryForeground,
        fontSize: size * 0.5,
      }}
    >
      {appIconLetter(theme.productName)}
    </div>,
    { width: size, height: size },
  );
}
