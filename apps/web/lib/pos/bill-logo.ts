import { BILL_LOGO_MAX_LENGTH } from '@durby/shared';

/** The bill logo's box on the 80 mm roll (docs/modules/pos.md → Bill layout). */
export const LOGO_MAX_WIDTH = 384;
export const LOGO_MAX_HEIGHT = 192;

/** The size that fits `width × height` into the logo box, never enlarged. */
export function logoSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, LOGO_MAX_WIDTH / width, LOGO_MAX_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * RGBA in place to gray on white: transparent pixels become white (thermal paper), colors their
 * luminance (thermal printers print black only).
 */
export function toGrayOnWhite(rgba: Uint8ClampedArray): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3]! / 255;
    const luminance = 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!;
    const gray = Math.round(luminance * alpha + 255 * (1 - alpha));
    rgba[i] = gray;
    rgba[i + 1] = gray;
    rgba[i + 2] = gray;
    rgba[i + 3] = 255;
  }
}

/**
 * An uploaded image as the bill logo: shrunk into the logo box, gray on white, as a PNG data URL
 * (a JPEG one if the PNG is too long for the setting). Null if the file isn't a readable image or
 * still too large.
 */
export async function logoDataUrl(file: Blob): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const { width, height } = logoSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const pixels = context.getImageData(0, 0, width, height);
  toGrayOnWhite(pixels.data);
  context.putImageData(pixels, 0, 0);
  for (const url of [canvas.toDataURL('image/png'), canvas.toDataURL('image/jpeg', 0.85)]) {
    if (url.length <= BILL_LOGO_MAX_LENGTH && /^data:image\/(png|jpeg);/.test(url)) return url;
  }
  return null;
}
