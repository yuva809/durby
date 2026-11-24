import { headers } from 'next/headers';
import { appIcon } from '../lib/app-icon';
import { fetchTheme } from '../lib/theme';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** The icon iPhones and iPads put on the home screen (ADR 0083). */
export default async function AppleIcon() {
  return appIcon(await fetchTheme((await headers()).get('host')), size.width);
}
