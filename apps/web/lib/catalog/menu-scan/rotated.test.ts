import { describe, expect, it } from 'vitest';
import type { OcrLine } from './parse';
import {
  besideHeading,
  isReadable,
  mayHoldSidewaysText,
  pickHeadings,
  sidewaysScore,
  unrotateBox,
} from './rotated';

const word = (text: string, confidence: number) => ({
  text,
  confidence,
  box: { x0: 0, y0: 0, x1: 10, y1: 10 },
});

describe('mayHoldSidewaysText', () => {
  it('is true for a tall narrow strip only', () => {
    expect(mayHoldSidewaysText(198, 1800)).toBe(true);
    expect(mayHoldSidewaysText(55, 1800)).toBe(true);
    expect(mayHoldSidewaysText(586, 1800)).toBe(false);
    expect(mayHoldSidewaysText(900, 1273)).toBe(false);
  });
});

describe('sidewaysScore and isReadable', () => {
  it('scores the letters of confident words', () => {
    expect(sidewaysScore([word('SALAT', 91), word('a', 95), word('xx', 30)])).toBe(5);
    expect(sidewaysScore([word('SALAT', 40)])).toBe(0);
  });

  it('needs one real word, so digits and ornaments turned upright are not a heading', () => {
    expect(isReadable([word('SALAT', 91)])).toBe(true);
    expect(isReadable([word('16', 90), word('LL', 60), word('=', 80)])).toBe(false);
    expect(isReadable([word('SALAT', 50)])).toBe(false);
  });
});

describe('unrotateBox', () => {
  // A strip 100 wide and 400 tall, at x = 30 on the page.
  const size = { width: 100, height: 400 };

  it('maps a clockwise copy (text reading upward) back to the page', () => {
    // In the 400 × 100 copy, the word starts at the left (x 20..120) in the top 40 rows (y 10..50):
    // on the page that is the strip's bottom (y 280..380), 10..50 from its left edge.
    expect(unrotateBox({ x0: 20, y0: 10, x1: 120, y1: 50 }, 'cw', size, 30)).toEqual({
      x0: 40,
      x1: 80,
      y0: 280,
      y1: 380,
    });
  });

  it('maps a counter-clockwise copy (text reading downward) back to the page', () => {
    // The word starts at the left of the copy: the top of the strip; its first rows are the strip's right.
    expect(unrotateBox({ x0: 20, y0: 10, x1: 120, y1: 50 }, 'ccw', size, 30)).toEqual({
      x0: 80,
      x1: 120,
      y0: 20,
      y1: 120,
    });
  });
});

describe('pickHeadings', () => {
  const line = (text: string, x0: number, x1: number, y0: number, y1: number): OcrLine => ({
    text,
    confidence: 90,
    page: 1,
    strip: 0,
    box: { x0, x1, y0, y1 },
  });

  it('keeps the title and drops the thinner subtitle beside it, even when it is not much thinner', () => {
    const picked = pickHeadings([
      line('(SERVIERT MIT REIS)', 171, 219, 1400, 1905),
      line('HAUPTGERICHT - VEGETARISCH', 90, 152, 786, 1904),
    ]);
    expect(picked.map((l) => l.text)).toEqual(['HAUPTGERICHT - VEGETARISCH']);
    // As tall as its type, not as long as the page.
    expect(picked[0]!.box).toEqual({ x0: 90, x1: 152, y0: 786, y1: 848 });
  });

  it('keeps two headings that do not overlap, top first', () => {
    const picked = pickHeadings([
      line('DESSERT', 50, 120, 900, 1200),
      line('SALAT', 50, 120, 100, 300),
    ]);
    expect(picked.map((l) => l.text)).toEqual(['SALAT', 'DESSERT']);
  });

  it('leaves out noise: short thick lines, little confidence, no letters', () => {
    const picked = pickHeadings([
      line('HAUPTGERICHT - LAMM', 60, 120, 600, 1500),
      { ...line('EI', 97, 226, 444, 471) },
      { ...line('fed nua', 97, 271, 444, 480), confidence: 69 },
      { ...line('w ww w w', 226, 248, 1554, 1837), confidence: 12 },
      line('16 17 18', 230, 260, 1500, 2000),
    ]);
    expect(picked.map((l) => l.text)).toEqual(['HAUPTGERICHT - LAMM']);
  });

  it('trims a stray mark in front of the name', () => {
    expect(
      pickHeadings([line('[ HAUPTGERICHT - MEERESFRUCHTE', 46, 120, 769, 2033)])[0]!.text,
    ).toBe('HAUPTGERICHT - MEERESFRUCHTE');
  });
});

describe('besideHeading', () => {
  const strips = [
    { x0: 0, x1: 431 },
    { x0: 524, x1: 1697 },
  ];

  it('reads the rest of the heading strip with the next strip', () => {
    expect(besideHeading(strips, 0, 233.4)).toEqual([
      { x0: 0, x1: 431 },
      { x0: 238, x1: 1697 },
    ]);
  });

  it('adds the rest as a strip of its own when the heading strip is the last', () => {
    expect(besideHeading([{ x0: 0, x1: 431 }], 0, 233)).toEqual([
      { x0: 0, x1: 431 },
      { x0: 237, x1: 431 },
    ]);
  });

  it('changes nothing when the heading fills its strip', () => {
    expect(besideHeading(strips, 0, 430)).toEqual(strips);
  });
});
