import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { APP_ICON_SIZES } from '../lib/app-icon';
import { fetchTheme } from '../lib/theme';

/** The home-screen web app of the request's partner: iPhones allow push only there (ADR 0083). */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { productName, tokens } = await fetchTheme((await headers()).get('host'));
  return {
    id: '/',
    name: productName,
    short_name: productName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: tokens.background,
    theme_color: tokens.background,
    icons: APP_ICON_SIZES.map((size) => ({
      src: `/app-icon/${size}`,
      sizes: `${size}x${size}`,
      type: 'image/png',
    })),
  };
}
