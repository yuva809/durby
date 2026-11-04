import { type PublicMenu, publicMenuSchema } from '@durby/shared';
import type { ApiErrorCode } from '../auth/errors';
import { errorCode } from '../auth/session';

/** The public table menu (docs/modules/pos.md → QR menu): no session, the link is the key. */

export type Result<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode | 'unknown' };

export async function loadPublicMenu(
  link: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<PublicMenu>> {
  try {
    const res = await fetchImpl(`/api/v1/public/menu/${encodeURIComponent(link)}`, {
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!res.ok) return { ok: false, code: await errorCode(res) };
    const parsed = publicMenuSchema.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, code: 'unknown' };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}
