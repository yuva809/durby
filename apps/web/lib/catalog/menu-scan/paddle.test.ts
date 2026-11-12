import { describe, expect, it } from 'vitest';
import { type PaddleItem, toOcrWords } from './paddle';

const item = (text: string, x: number, y: number, confidence = 0.9): PaddleItem => ({
  text,
  box: { x, y, width: 100, height: 20 },
  confidence,
});

describe('toOcrWords', () => {
  it('turns boxes into page corners and confidence into 0–100', () => {
    expect(toOcrWords([[item('Butter Chicken', 10, 40, 0.876)]])).toEqual([
      [{ text: 'Butter Chicken', confidence: 87.6, box: { x0: 10, y0: 40, x1: 110, y1: 60 } }],
    ]);
  });

  it('moves the words of a strip to where the strip sits on the page', () => {
    const word = toOcrWords([[item('16,90', 5, 0)]], 800)[0]?.[0];
    expect(word?.box).toEqual({ x0: 805, y0: 0, x1: 905, y1: 20 });
  });

  it('keeps lines and words in order, trims text and drops empty readings', () => {
    const words = toOcrWords([
      [item(' Naan ', 0, 0), item('3,90', 300, 0)],
      [item('  ', 0, 40)],
      [item('', 0, 80), item('Garlic Naan', 0, 80)],
    ]);
    expect(words.map((line) => line.map((w) => w.text))).toEqual([
      ['Naan', '3,90'],
      ['Garlic Naan'],
    ]);
  });

  it('drops readings in Chinese, Japanese or Korean script (noise from photos)', () => {
    const words = toOcrWords([
      [item('大', 0, 0), item('Hähnchen', 50, 0)],
      [item('。', 0, 40)],
      [item('2号', 0, 80)],
      [item('11,90 €', 0, 120)],
    ]);
    expect(words.map((line) => line.map((w) => w.text))).toEqual([['Hähnchen'], ['11,90 €']]);
  });
});
