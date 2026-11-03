import { describe, expect, it } from 'vitest';
import type { OcrLine } from './parse';
import { readingScore } from './reading-score';

const line = (text: string, confidence: number, y: number): OcrLine => ({
  text,
  confidence,
  page: 1,
  box: { x0: 0, y0: y, x1: 300, y1: y + 20 },
});

describe('readingScore', () => {
  it('adds up the confidence of the products read', () => {
    expect(readingScore([line('Chicken 65 11,90 €', 90, 0), line('Soup 5,50 €', 80, 40)])).toBe(
      170,
    );
  });

  it('scores a reading with garbage lower than a clean one', () => {
    const clean = [line('Butter Chicken 18,90 €', 92, 0), line('Beer 4,50 €', 90, 40)];
    const garbled = [line('Bttr Chcken 18,90 €', 40, 0), line('( | 4,50', 20, 40)];
    expect(readingScore(clean)).toBeGreaterThan(readingScore(garbled));
  });

  it('is 0 for a page with no products', () => {
    expect(readingScore([line('Menu', 90, 0)])).toBe(0);
    expect(readingScore([])).toBe(0);
  });
});
