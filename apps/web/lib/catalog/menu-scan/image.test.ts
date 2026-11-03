import { describe, expect, it } from 'vitest';
import { findStrips, flattenPaper, prepareForOcr } from './image';

/** A `width` × `height` RGBA image filled by `colour(x, y)`. */
function image(
  width: number,
  height: number,
  colour: (x: number, y: number) => [number, number, number],
) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      const i = (y * width + x) * 4;
      rgba.set([r, g, b, 255], i);
    }
  }
  return rgba;
}
const at = (rgba: Uint8Array, width: number, x: number, y: number) => rgba[(y * width + x) * 4]!;

const ORANGE: [number, number, number] = [240, 194, 116];
const WHITE: [number, number, number] = [250, 250, 248];
const RED: [number, number, number] = [200, 30, 30];

describe('prepareForOcr', () => {
  it('turns red text on orange paper and on white paper into dark text on white', () => {
    // Left half orange, right half white, a red "text" bar in both.
    const rgba = image(200, 100, (x, y) =>
      y >= 45 && y < 55 && x % 100 >= 20 && x % 100 < 80 ? RED : x < 100 ? ORANGE : WHITE,
    );
    prepareForOcr(rgba, 200, 100);
    expect(at(rgba, 200, 10, 10)).toBeGreaterThan(230); // orange paper → white
    expect(at(rgba, 200, 150, 10)).toBeGreaterThan(230); // white paper → white
    expect(at(rgba, 200, 50, 50)).toBeLessThan(80); // red text on orange → dark
    expect(at(rgba, 200, 150, 50)).toBeLessThan(80); // red text on white → dark
  });

  it('whitens a vertical rule (a panel edge) but keeps text', () => {
    const rgba = image(100, 100, (x, y) =>
      x === 50 ? [20, 20, 20] : y === 30 && x < 40 ? [20, 20, 20] : WHITE,
    );
    prepareForOcr(rgba, 100, 100);
    expect(at(rgba, 100, 50, 70)).toBe(255);
    expect(at(rgba, 100, 10, 30)).toBeLessThan(80);
  });
});

describe('flattenPaper', () => {
  it('evens out a shadow across the page', () => {
    const width = 120;
    const height = 60;
    // Paper darkening from 240 to 140 left to right (a shadow), no text.
    const gray = new Uint8Array(width * height).map(
      (_, p) => 240 - Math.round(((p % width) / width) * 100),
    );
    const flat = flattenPaper(gray, width, height);
    expect(Math.min(...flat)).toBeGreaterThan(200);
  });
});

describe('findStrips', () => {
  it('splits two text columns at the gutter between them', () => {
    const width = 400;
    const height = 200;
    // Text-like rows in x 10–180 and 220–390, a clean gutter in between.
    const rgba = image(width, height, (x, y) =>
      y % 20 < 8 && ((x > 10 && x < 180) || (x > 220 && x < 390)) && x % 7 !== 0
        ? [0, 0, 0]
        : [255, 255, 255],
    );
    const strips = findStrips(rgba, width, height, 4);
    expect(strips).toHaveLength(2);
    expect(strips[0]!.x1).toBeGreaterThan(175);
    expect(strips[1]!.x0).toBeLessThan(225);
  });

  it('keeps one strip when there is no gutter', () => {
    const rgba = image(200, 100, (x, y) =>
      y % 20 < 8 && x % 9 !== 0 ? [0, 0, 0] : [255, 255, 255],
    );
    expect(findStrips(rgba, 200, 100, 4)).toEqual([{ x0: 0, x1: 200 }]);
  });
});
