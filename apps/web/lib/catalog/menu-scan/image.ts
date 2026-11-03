/**
 * Pixel preparation for menu OCR (docs/modules/catalog.md → Menu scan), pure so it runs the same
 * on a canvas and in tests.
 *
 * 1. Each pixel becomes its darkest colour channel: red, blue or green text on white, cream or
 *    orange paper turns dark (plain greyscale makes red on orange almost the same grey).
 * 2. The paper is flattened: its brightness is estimated block by block (the brightest pixels
 *    nearby) and every pixel is divided by it, so coloured panels, shadows and uneven light all
 *    become white while text stays dark. OCR engines threshold the whole page at once; without
 *    this, a darker panel of the menu is read as one dark area and its text is lost.
 * 3. The levels are stretched: the darkest 1 % black, the lightest 1 % white.
 */

const CLIP = 0.01;
/** Blocks per short edge for the paper estimate (each spans a few text lines). */
const BLOCKS = 50;
/** The share of a block's pixels darker than its paper estimate. */
const PAPER_PERCENTILE = 0.9;
/** Areas whose brightest pixels stay below this have no paper (borders, dark photos). */
const NO_PAPER = 60;

/** In place on RGBA bytes (as `ImageData.data`) of a `width` × `height` image; alpha opaque. */
export function prepareForOcr(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): void {
  const gray = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    gray[p] = Math.min(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
  }
  const flat = flattenPaper(gray, width, height);
  const histogram = new Uint32Array(256);
  for (const value of flat) histogram[value]! += 1;
  const clip = Math.floor(flat.length * CLIP);
  let low = 0;
  for (let seen = 0; low < 255 && seen + histogram[low]! <= clip; low++) seen += histogram[low]!;
  let high = 255;
  for (let seen = 0; high > 0 && seen + histogram[high]! <= clip; high--) seen += histogram[high]!;
  const range = high - low;
  for (let p = 0, i = 0; p < flat.length; p++, i += 4) {
    const v = flat[p]!;
    const value =
      range <= 0 ? v : Math.max(0, Math.min(255, Math.round(((v - low) * 255) / range)));
    rgba[i] = value;
    rgba[i + 1] = value;
    rgba[i + 2] = value;
    rgba[i + 3] = 255;
  }
  eraseRules(rgba, width, height);
}

/** A pixel column inked over more than this share of the height is a rule or shadow, not text. */
const RULE = 0.5;

/**
 * Whitens vertical rules: panel edges, folds and shadows run down the page, while no text column
 * is inked over half the height. Left in place, OCR reads them as `l`, `|` or `(` and garbles the
 * prices that touch them.
 */
function eraseRules(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): void {
  for (let x = 0; x < width; x++) {
    let ink = 0;
    for (let y = 0; y < height; y++) if (rgba[(y * width + x) * 4]! < INK) ink++;
    if (ink <= RULE * height) continue;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      rgba[i] = 255;
      rgba[i + 1] = 255;
      rgba[i + 2] = 255;
    }
  }
}

/**
 * Each pixel divided by the paper brightness around it: per block the 90th-percentile brightness
 * (paper outweighs text even in a heading's block; a stray highlight doesn't count), interpolated
 * between block centres.
 */
export function flattenPaper(gray: Uint8Array, width: number, height: number): Uint8Array {
  const size = Math.max(8, Math.round(Math.min(width, height) / BLOCKS));
  const bw = Math.ceil(width / size);
  const bh = Math.ceil(height / size);
  const paper = new Uint8Array(bw * bh);
  const histogram = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      histogram.fill(0);
      const yEnd = Math.min(height, (by + 1) * size);
      const xEnd = Math.min(width, (bx + 1) * size);
      let count = 0;
      for (let y = by * size; y < yEnd; y++) {
        for (let x = bx * size; x < xEnd; x++) {
          histogram[gray[y * width + x]!]! += 1;
          count++;
        }
      }
      let value = 255;
      for (let above = 0; value > 0; value--) {
        above += histogram[value]!;
        if (above >= count * (1 - PAPER_PERCENTILE)) break;
      }
      paper[by * bw + bx] = value;
    }
  }
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / size - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / size - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const top = paper[y0 * bw + x0]! * (1 - tx) + paper[y0 * bw + x1]! * tx;
      const bottom = paper[y1 * bw + x0]! * (1 - tx) + paper[y1 * bw + x1]! * tx;
      const background = top * (1 - ty) + bottom * ty;
      const p = y * width + x;
      // No paper around (a black border, a dark photo): nothing to read there.
      out[p] =
        background < NO_PAPER ? 255 : Math.min(255, Math.round((gray[p]! * 255) / background));
    }
  }
  return out;
}

/** Pixels darker than this (after `prepareForOcr`) count as ink. */
const INK = 128;
/** A gutter is at least this share of the width wide… */
const GUTTER_MIN = 0.004;
/** …and has ink in at most this share of its rows. */
const GUTTER_INK = 0.03;
/** Narrower strips are merged into a neighbour. */
const STRIP_MIN = 0.06;

export interface Strip {
  x0: number;
  x1: number;
}

/**
 * The page's columns as vertical strips, split at gutters: runs of pixel columns with almost no
 * ink from top to bottom. Reading each strip on its own keeps OCR engines from mixing the lines of
 * side-by-side menu columns. A gap between names and their right-aligned prices may also count as a
 * gutter; `joinPriceLines` (parse.ts) puts those prices back on their lines.
 */
export function findStrips(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride = 1,
): Strip[] {
  const ink = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[(y * width + x) * stride]! < INK) ink[x]! += 1;
    }
  }
  const quiet = (x: number) => ink[x]! <= GUTTER_INK * height;
  const minGutter = Math.max(4, Math.round(GUTTER_MIN * width));
  const strips: Strip[] = [];
  let start = 0;
  let x = 0;
  while (x < width) {
    if (!quiet(x)) {
      x++;
      continue;
    }
    let end = x;
    while (end < width && quiet(end)) end++;
    if (end - x >= minGutter) {
      if (x > start) strips.push({ x0: start, x1: x });
      start = end;
    }
    x = end;
  }
  if (width > start) strips.push({ x0: start, x1: width });
  // Slivers (a stray mark, a fold line) join the neighbour they are closest to.
  const min = STRIP_MIN * width;
  const merged: Strip[] = [];
  for (const strip of strips) {
    const last = merged[merged.length - 1];
    if (last && (strip.x1 - strip.x0 < min || last.x1 - last.x0 < min)) last.x1 = strip.x1;
    else merged.push({ ...strip });
  }
  return merged.length > 0 ? merged : [{ x0: 0, x1: width }];
}
