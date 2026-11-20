import { headers } from 'next/headers';
import { fetchTheme } from '../../lib/theme';

/**
 * The web manifest for installing the app on a phone (ADR 0072): the partner's name and logo from the theme of the
 * host, starting at the till.
 */
export async function GET() {
  const theme = await fetchTheme((await headers()).get('host'));
  const icons = theme.logoUrl ? [{ src: theme.logoUrl, sizes: 'any' }] : [];
  return Response.json(
    {
      name: theme.productName,
      short_name: theme.productName,
      start_url: '/service',
      scope: '/',
      display: 'standalone',
      icons,
    },
    { headers: { 'Content-Type': 'application/manifest+json' } },
  );
}
