import type { Box, OcrLine } from './parse';

/**
 * Category headings set sideways down the side of a menu page (docs/modules/catalog.md → Menu
 * scan): the PDF path reads them from the text layer, photos need the strip turned upright for
 * OCR. Pure: the canvas work is in `ocr.ts`.
 */

export type Rotation = 'cw' | 'ccw';

/** A column strip at most this share of its height wide may hold sideways text. */
const NARROW = 0.2;
/** A heading needs a word of at least this many letters, read with at least this confidence. */
const MIN_LETTERS = 4;
const MIN_CONFIDENCE = 70;
/** A heading line needs this much confidence, three letters, and to be at least this many times longer than thick. */
const LINE_CONFIDENCE = 50;
const MIN_ASPECT = 1.5;

export const mayHoldSidewaysText = (width: number, height: number) =>
  width > 0 && width <= NARROW * height;

export interface RotatedWord {
  text: string;
  confidence: number;
  /** In the rotated image. */
  box: Box;
}

const letterCount = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;

/** Letters in the confident words of a reading: sideways text read upright scores, the wrong way doesn't. */
export function sidewaysScore(words: readonly RotatedWord[]): number {
  return words
    .filter((w) => w.confidence >= MIN_CONFIDENCE && letterCount(w.text) >= 3)
    .reduce((sum, w) => sum + letterCount(w.text), 0);
}

/** Whether a reading is a heading at all and not the noise of digits or ornaments turned upright. */
export const isReadable = (words: readonly RotatedWord[]) =>
  words.some((w) => w.confidence >= MIN_CONFIDENCE && letterCount(w.text) >= MIN_LETTERS);

/**
 * A box in the turned copy of a strip back to the page. The strip is `size` (width × height) and
 * starts at `x0` on the page; 'cw' is the copy turned a quarter clockwise (text that reads upward),
 * 'ccw' counter-clockwise (text that reads downward).
 */
export function unrotateBox(
  box: Box,
  rotation: Rotation,
  size: { width: number; height: number },
  x0: number,
): Box {
  return rotation === 'cw'
    ? { x0: x0 + box.y0, x1: x0 + box.y1, y0: size.height - box.x1, y1: size.height - box.x0 }
    : { x0: x0 + size.width - box.y1, x1: x0 + size.width - box.y0, y0: box.x0, y1: box.x1 };
}

/**
 * The headings among the lines read from one sideways strip (boxes already on the page). Noise
 * (the digits and ornaments beside a heading, a status bar read sideways) is left out: a heading
 * is read with some confidence, has letters, and is much longer than it is thick. The thickness of
 * a line (its width on the page) is its type size, and two headings can't stand side by side over
 * the same stretch of the strip: a thinner line beside a thicker one is a subtitle
 * (`(Serviert mit Reis)`) and left out too. A heading's box is as tall as its type, so the parser
 * sees a line of its size, not one as long as the page.
 */
export function pickHeadings(lines: readonly OcrLine[]): OcrLine[] {
  const thickness = (l: OcrLine) => l.box.x1 - l.box.x0;
  const length = (l: OcrLine) => l.box.y1 - l.box.y0;
  const overlap = (a: OcrLine, b: OcrLine) =>
    Math.min(a.box.y1, b.box.y1) - Math.max(a.box.y0, b.box.y0);
  const plausible = lines
    // A stray mark in front of the first letter ("[ HAUPTGERICHT") is not part of the name.
    .map((l) => ({ ...l, text: l.text.replace(/^[^\p{L}\d(]+/u, '').trim() }))
    .filter(
      (l) =>
        l.confidence >= LINE_CONFIDENCE &&
        letterCount(l.text) >= 3 &&
        length(l) >= MIN_ASPECT * thickness(l),
    );
  const kept: OcrLine[] = [];
  for (const line of plausible.sort((a, b) => thickness(b) - thickness(a))) {
    const subtitle = kept.some((big) => overlap(line, big) > 0.5 * length(line));
    if (!subtitle) kept.push(line);
  }
  return kept
    .sort((a, b) => a.box.y0 - b.box.y0)
    .map((l) => ({ ...l, box: { ...l.box, y1: l.box.y0 + thickness(l) } }));
}

/** Space left between a sideways heading and the text read beside it, in pixels. */
const BESIDE_HEADING_GAP = 4;

/**
 * The strips to read once strip `index` turned out to hold a sideways heading ending at
 * `headingRight`: the rest of that strip, right of the heading, is read with the strip after it.
 * On a page with few lines of text the columns through the start of the names hold so little ink
 * that they pass for a gutter, and the heading's strip takes in the item numbers and first words.
 */
export function besideHeading<S extends { x0: number; x1: number }>(
  strips: readonly S[],
  index: number,
  headingRight: number,
): S[] {
  const strip = strips[index];
  if (!strip) return [...strips];
  const start = Math.ceil(headingRight) + BESIDE_HEADING_GAP;
  if (start >= strip.x1) return [...strips];
  const next = strips[index + 1];
  return next
    ? [...strips.slice(0, index + 1), { ...next, x0: start }, ...strips.slice(index + 2)]
    : [...strips, { ...strip, x0: start }];
}
