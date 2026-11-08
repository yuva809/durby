/**
 * Turning the rendered bill into printer dots (docs/modules/android-app.md → Print flow; from the print-bridge
 * spike, where it was checked on staging). The bill is re-laid-out at the printer's width, never shrunk: 2 dots per
 * css px, so 12 px text prints 24 dots (3 mm) high on every paper width.
 */

export const DOTS_PER_CSS_PX = 2;

export interface RenderGeometry {
  /** The width the bill is laid out at. */
  cssWidth: number;
  pixelRatio: number;
  canvasWidth: number;
}

/** 384 dots (58 mm) → 192 css px; 576 → 288; 512 → 256. */
export function renderGeometry(widthDots: number): RenderGeometry {
  if (!(widthDots >= 8 && widthDots <= 2040)) throw new Error(`widthDots ${widthDots}`);
  const cssWidth = Math.floor(widthDots / DOTS_PER_CSS_PX);
  return { cssWidth, pixelRatio: DOTS_PER_CSS_PX, canvasWidth: cssWidth * DOTS_PER_CSS_PX };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * RGBA → 1 bit per dot (row-major, rows padded to whole bytes, MSB = leftmost dot, 1 = black). Text is thresholded
 * for crisp edges; pixels inside `ditherRects` (the logo) get Floyd–Steinberg so grey stays grey.
 */
export function packBits(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  ditherRects: readonly Rect[] = [],
): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const bits = new Uint8Array(rowBytes * height);
  const lum = new Float32Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const a = rgba[i + 3]! / 255;
    lum[p] = (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * a + 255 * (1 - a);
  }
  const inDither = (x: number, y: number) =>
    ditherRects.some((d) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      const v = lum[k]!;
      let black: boolean;
      if (inDither(x, y)) {
        black = v < 128;
        const err = v - (black ? 0 : 255);
        if (x + 1 < width && inDither(x + 1, y)) lum[k + 1]! += (err * 7) / 16;
        if (y + 1 < height) {
          if (x > 0 && inDither(x - 1, y + 1)) lum[k + width - 1]! += (err * 3) / 16;
          if (inDither(x, y + 1)) lum[k + width]! += (err * 5) / 16;
          if (x + 1 < width && inDither(x + 1, y + 1)) lum[k + width + 1]! += err / 16;
        }
      } else {
        black = v < 160;
      }
      if (black) bits[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return bits;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
