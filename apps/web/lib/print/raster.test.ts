import { describe, expect, it } from 'vitest';
import { packBits, renderGeometry, toBase64 } from './raster';

const rgba = (w: number, h: number, grey: number) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([grey, grey, grey, 255], i * 4);
  return px;
};
const black = (bits: Uint8Array, w: number, x: number, y: number) =>
  (bits[y * Math.ceil(w / 8) + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;

describe('renderGeometry', () => {
  it('lays a 58 mm bill out at 192 css px, 2 dots per px: reflow, not shrink', () => {
    expect(renderGeometry(384)).toEqual({ cssWidth: 192, pixelRatio: 2, canvasWidth: 384 });
    expect(renderGeometry(576)).toEqual({ cssWidth: 288, pixelRatio: 2, canvasWidth: 576 });
  });
  it('refuses nonsense widths', () => {
    expect(() => renderGeometry(0)).toThrow();
    expect(() => renderGeometry(5000)).toThrow();
    expect(() => renderGeometry(Number.NaN)).toThrow();
  });
});

describe('packBits', () => {
  it('packs a 384-dot row into 48 bytes, leftmost dot in the high bit', () => {
    const px = rgba(384, 1, 255);
    px.set([0, 0, 0, 255], 0);
    px.set([0, 0, 0, 255], 383 * 4);
    const bits = packBits(px, 384, 1);
    expect(bits.length).toBe(48);
    expect(bits[0]).toBe(0x80);
    expect(bits[47]).toBe(0x01);
    expect(bits.subarray(1, 47).every((b) => b === 0)).toBe(true);
  });

  it('thresholds text: dark grey prints, light grey and transparent do not', () => {
    const px = new Uint8ClampedArray([100, 100, 100, 255, 200, 200, 200, 255, 0, 0, 0, 0]);
    const bits = packBits(px, 3, 1);
    expect([0, 1, 2].map((x) => black(bits, 3, x, 0))).toEqual([true, false, false]);
  });

  it('dithers the logo area and leaves the rest thresholded', () => {
    const bits = packBits(rgba(64, 32, 170), 64, 32, [{ x: 0, y: 0, w: 32, h: 32 }]);
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 64; x++) {
        if (!black(bits, 64, x, y)) continue;
        if (x < 32) inside++;
        else outside++;
      }
    expect(inside).toBeGreaterThan(1024 * 0.25);
    expect(inside).toBeLessThan(1024 * 0.42);
    expect(outside).toBe(0);
  });
});

describe('toBase64', () => {
  it('encodes large images in chunks', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
