'use client';

import {
  CATEGORY_IMAGE_MAX_BYTES,
  CATEGORY_IMAGE_MAX_SIDE,
  type ProductCategory,
  productCategorySchema,
} from '@durby/shared';
import { useEffect, useState } from 'react';
import { type Api, type Result, write } from '../api-call';
import { errorCode } from '../auth/session';
import { type ActionKey, withIdempotencyKey } from '../idempotency';

/**
 * Category tile images (docs/modules/inventory.md → Categories, ADR 0048): resized here to WebP before upload, sent as
 * their raw bytes, read back through the api (it needs the token, so no plain <img src>).
 */

const path = (id: string) => `/api/v1/catalog/categories/${id}/image`;

/** Uploads `image` (already resized) as the category's tile image. */
export async function uploadCategoryImage(
  store: Api,
  action: ActionKey,
  id: string,
  image: Blob,
): Promise<Result<ProductCategory>> {
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
    const parsed = productCategorySchema.safeParse(await res.json());
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, code: 'unknown' };
  } catch {
    return { ok: false, code: 'unknown' };
  }
}

export const removeCategoryImage = (
  store: Api,
  action: ActionKey,
  id: string,
): Promise<Result<ProductCategory | null>> =>
  write(store, action, path(id), 'DELETE', undefined, productCategorySchema);

/**
 * The tile image of `category` as an object URL, or null without one (or while loading, or on failure: the tile
 * shows its colour). A new imageVersion fetches again; old URLs are revoked.
 */
export function useCategoryImage(
  store: Api,
  category: Pick<ProductCategory, 'id' | 'imageVersion'> | null,
): string | null {
  const id = category?.id ?? null;
  const version = category?.imageVersion ?? null;
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  const key = id && version ? `${id}:${version}` : null;

  useEffect(() => {
    if (!id || !version) return;
    let url: string | null = null;
    let current = true;
    void store
      .apiFetch(`${path(id)}?v=${encodeURIComponent(version)}`, { cache: 'force-cache' })
      .then(async (res) => {
        if (!res.ok || !current) return;
        url = URL.createObjectURL(await res.blob());
        if (current) setImage({ key: `${id}:${version}`, url });
        else URL.revokeObjectURL(url);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [store, id, version]);

  return image && image.key === key ? image.url : null;
}

/**
 * The picked file as a WebP of at most CATEGORY_IMAGE_MAX_SIDE px on its longest side and at most
 * CATEGORY_IMAGE_MAX_BYTES, lowering the quality until it fits; null when the browser can't read it as an image.
 * A transparent background becomes white (tiles are opaque).
 */
export async function resizeCategoryImage(file: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const scale = Math.min(1, CATEGORY_IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of [0.85, 0.75, 0.6, 0.45, 0.3]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality),
    );
    // A browser without WebP encoding answers PNG: still one of the accepted types.
    if (blob && blob.size <= CATEGORY_IMAGE_MAX_BYTES) return blob;
  }
  return null;
}

/** Tile colours for categories without an image: picked by the id, so a category keeps its colour. */
export const CATEGORY_TILE_COLORS = [
  '#1e3a8a',
  '#3b2fc9',
  '#7c3aed',
  '#be123c',
  '#c2410c',
  '#ca8a04',
  '#0f766e',
  '#15803d',
  '#0369a1',
  '#9d174d',
] as const;

export function categoryColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CATEGORY_TILE_COLORS[hash % CATEGORY_TILE_COLORS.length]!;
}
