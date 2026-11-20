'use client';

import { type Product, productSchema } from '@durby/shared';
import { type Api, type Result, write } from '../api-call';
import { errorCode } from '../auth/session';
import { type ActionKey, withIdempotencyKey } from '../idempotency';

/**
 * A product's picture (docs/modules/catalog.md, ADR 0049): resized here with the category tile routine
 * (`resizeCategoryImage`), sent as raw bytes, read back through the api (it needs the token).
 */

const path = (id: string) => `/api/v1/catalog/products/${id}/image`;

/** Uploads `image` (already resized) as the product's picture. */
export async function uploadProductImage(
  store: Api,
  action: ActionKey,
  id: string,
  image: Blob,
): Promise<Result<Product>> {
  const input = path(id);
  // One action per file: the same file again keeps the key (a retry), another file gets a new one.
  const key = action.for({ input, method: 'PUT', type: image.type, size: image.size });
  try {
    const res = await store.apiFetch(
      input,
      withIdempotencyKey(
        { method: 'PUT', body: image, headers: { 'Content-Type': image.type }, cache: 'no-store' },
        key,
      ),
    );
    if (res.status < 500) action.done();
    if (!res.ok) return { ok: false, code: await errorCode(res) };
    const parsed = productSchema.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, code: 'unknown' };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

export const removeProductImage = (
  store: Api,
  action: ActionKey,
  id: string,
): Promise<Result<Product | null>> =>
  write(store, action, path(id), 'DELETE', undefined, productSchema);
