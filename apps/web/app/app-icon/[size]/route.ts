import { headers } from 'next/headers';
import { APP_ICON_SIZES, appIcon } from '../../../lib/app-icon';
import { fetchTheme } from '../../../lib/theme';

/** The manifest's icons, in the sizes it names only. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> },
): Promise<Response> {
  const { size } = await params;
  const known = APP_ICON_SIZES.find((s) => String(s) === size);
  if (known === undefined) return new Response(null, { status: 404 });
  return appIcon(await fetchTheme((await headers()).get('host')), known);
}
