import type { MetadataRoute } from 'next';
import { createTranslator, DEFAULT_LOCALE } from '@durby/i18n';
import { headers } from 'next/headers';
import { APP_ICON_SIZES } from '../lib/app-icon';
import { fetchTheme } from '../lib/theme';

/**
 * The home-screen web app of the request's partner: iPhones allow push only there (ADR 0083), and waiters take orders in
 * it (ADR 0072). One app for both: it starts on the home page, which leads waiters on to Service.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { productName, tokens } = await fetchTheme((await headers()).get('host'));
  return {
    id: '/',
    name: productName,
    short_name: productName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    shortcuts: [{ name: createTranslator(DEFAULT_LOCALE)('pos.nav.service'), url: '/service' }],
    background_color: tokens.background,
    theme_color: tokens.background,
    icons: APP_ICON_SIZES.map((size) => ({
      src: `/app-icon/${size}`,
      sizes: `${size}x${size}`,
      type: 'image/png',
    })),
  };
}
